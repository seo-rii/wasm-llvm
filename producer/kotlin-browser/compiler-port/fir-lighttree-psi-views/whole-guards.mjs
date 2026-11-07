import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { HOST } from './transform.mjs';
import { reopenPsiBuild } from './verify.mjs';

export async function qualifyWholePsiGuards(configuration) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const lockBytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
  const selectionBytes = await readRegular(path.join(here, 'selection.lock.json'));
  const toolInputs = [];
  for (const filename of new Set(['whole-guards.mjs', 'verify.mjs', 'diagnostics.mjs', 'diagnostic-drift.lock.json', 'fixture.mjs', 'sources.lock.json',
    ...lock.dependencies.map(pin => pin.path)].map(name => path.resolve(here, name)))) {
    const bytes = await readRegular(filename); toolInputs.push({ filename, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const build = await reopenPsiBuild(configuration.build);
  const outputRoot = path.resolve(configuration.outputRoot);
  assert(outputRoot.startsWith(path.join(configuration.build.snapshotRoot, 'out') + path.sep));
  assert(!outputRoot.startsWith(configuration.build.buildRoot + path.sep));
  await mkdir(outputRoot, { mode: 0o700 });
  const api = await import(pathToFileURL(path.join(build.port, 'fir-lighttree-psi-views/prepare.mjs')));
  const cases = [];
  async function mutated(name, logical, change) {
    const rows = structuredClone(build.actual), row = rows.find(value => value.path === logical);
    assert(row); assert(row.filename.startsWith(configuration.build.buildRoot + path.sep), 'Never mutate a historical baseline');
    const original = await readRegular(row.filename), modified = Buffer.from(change(original.toString()));
    assert.notDeepEqual(original, modified);
    const modifiedPath = path.join(outputRoot, name + '.kt');
    await writeFile(modifiedPath, modified, { flag: 'wx', mode: 0o600 });
    let failure;
    try {
      await writeFile(row.filename, modified); row.bytes = modified.length; row.sha256 = sha256(modified);
      try { await api.verifyFirLightTreePsiViewFinalSources({ ...build.psiOptions, retainedSources: rows }); }
      catch (error) { failure = error; }
    } finally {
      await writeFile(row.filename, original);
      assert.deepEqual(await readRegular(row.filename), original);
    }
    assert(failure, 'Changed source was accepted: ' + name);
    const reason = String(failure.message), reasonMatched = /(?:Selected PSI source bytes changed|Actual PSI source body changed)/.test(reason);
    assert(reasonMatched, 'Unexpected guard failure: ' + reason);
    cases.push({ name, logical, owner: row.filename, original: { bytes: original.length, sha256: sha256(original) },
      modified: { filename: modifiedPath, bytes: modified.length, sha256: sha256(modified) }, rejected: true, reasonMatched, reason });
  }
  await mutated('additional-sealed-source-subtype', HOST, text => text + '\nclass UnexpectedPsiSource : KtSourceElement()\n');
  await mutated('selected-metadata-caller-drift',
    'compiler/fir/fir2ir/src/org/jetbrains/kotlin/fir/backend/generators/Fir2IrCallableDeclarationsGenerator.kt', text => {
      const before = 'metadata = FirMetadataSource.Property(property)'; assert(text.includes(before));
      return text.replace(before, 'metadata = FirMetadataSource.Property(changedProperty)');
    });
  await mutated('portable-token-membership-drift', 'compiler-port-positioning/TokenSet.kt', text => {
    const before = 'element != null && element in elements'; assert(text.includes(before));
    return text.replace(before, 'element != null');
  });
  const restored = await api.verifyFirLightTreePsiViewFinalSources({ ...build.psiOptions, retainedSources: build.actual });
  assert.deepEqual(restored, build.psiFinal);
  for (const pin of toolInputs) {
    const bytes = await readRegular(pin.filename);
    assert.deepEqual({ bytes: bytes.length, sha256: sha256(bytes) }, { bytes: pin.bytes, sha256: pin.sha256 });
  }
  const receipt = { kind: 'actual-whole-fir-psi-source-guards', buildReceiptSha256: sha256(build.bytes),
    sourceLockSha256: sha256(lockBytes), selectionLockSha256: sha256(selectionBytes), toolInputs, toolInputsUnchanged: true,
    actualSources: build.actual.length, cases, restoredSourceState: true, compilerHadExitedBeforeMutation: true,
    fullCompilerBuilt: false, fullFirToIrWasmExecuted: false };
  const receiptPath = path.join(outputRoot, 'guards.json'); await writeJson(receiptPath, receipt);
  return { receiptPath, receipt };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv[2], 'Pass a completed whole-build guard configuration');
  const result = await qualifyWholePsiGuards(JSON.parse(await readRegular(path.resolve(process.argv[2]))));
  console.log(JSON.stringify({ receiptPath: result.receiptPath, cases: result.receipt.cases.length, restoredSourceState: true }));
}
