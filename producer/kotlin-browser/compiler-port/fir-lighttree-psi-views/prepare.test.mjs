import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { actualPredecessor } from './fixture.mjs';
import { prepareFirLightTreePsiViews, verifyFirLightTreePsiViewFinalSources } from './prepare.mjs';
import { UTILS, OFFSETS, CONVERTER, METADATA, TARGETS, transformPsiViews } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
test('authentic whole selection, exact five-file inverse and fail-closed source guards', async t => {
  const lockBytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
  const selectionBytes = await readRegular(path.join(here, 'selection.lock.json'));
  const toolInputs = [];
  for (const filename of new Set(['prepare.test.mjs', 'fixture.mjs', 'sources.lock.json',
    ...lock.dependencies.map(pin => pin.path)].map(name => path.resolve(here, name)))) {
    const bytes = await readRegular(filename); toolInputs.push({ filename, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const before = await actualPredecessor();
  await mkdir(path.join(repository, 'out/fir-psi-next'), { recursive: true });
  const parent = await mkdtemp(path.join(repository, 'out/fir-psi-next/guard-fixture-'));
  const component = await prepareFirLightTreePsiViews({ ...before, outputRoot: path.join(parent, 'psi') });
  const replacements = new Map(component.receipt.files.map(row => [row.before.path, row.after]));
  const actual = before.retainedSources.map(row => structuredClone(replacements.get(row.path) ?? row));
  const options = { sourceRoot: before.sourceRoot, outputRoot: component.outputRoot,
    expectedReceiptSha256: component.receiptSha256, recordedPropertyImports: before.recordedPropertyImports };
  const verify = rows => verifyFirLightTreePsiViewFinalSources({ ...options, retainedSources: rows });
  const result = await verify(actual);
  await t.test('all 3571 inputs and the previous exception delta roundtrip', async () => {
    assert.deepEqual(result.predecessorRetainedSources, before.retainedSources);
    assert.equal(result.receipt.actualSelectedSources, 3571);
    assert.equal(result.receipt.portableBindings.length, 2);
    assert.equal(actual.filter(row => row.path.startsWith('compiler-port-jvm-descriptor-signatures/')).length, 18);
    for (const logical of TARGETS) {
      const row = actual.find(row => row.path === logical), prior = before.retainedSources.find(row => row.path === logical);
      assert.deepEqual(transformPsiViews(logical, await readRegular(row.filename), { reverse: true }), await readRegular(prior.filename));
    }
    // Reopen the historical API in its own immutable snapshot. Its exact Utils
    // algorithm must still pass after the new layer's authenticated inverse.
    const snapshotRoot = path.resolve(before.buildRoot, '../..');
    const previous = await import(pathToFileURL(path.join(snapshotRoot,
      'producer/kotlin-browser/compiler-port/compiler-exception-attachment-profile/prepare.mjs')));
    const priorFinal = await previous.verifyCompilerExceptionAttachmentFinalSources({
      ...before.preparedExceptionProfile, sourceRoot: before.sourceRoot,
      recordedPropertyImports: before.recordedPropertyImports, retainedSources: result.predecessorRetainedSources });
    assert.deepEqual(priorFinal.receipt, before.receipt.compilerExceptionAttachmentFinalReceipt);
  });
  const rejected = [];
  async function rejects(name, rows, reason) {
    await t.test(name, async () => {
      await assert.rejects(() => verify(rows), reason); rejected.push(name);
    });
  }
  await rejects('partial selection rejected', actual.slice(1), /Complete 3571-source/);
  const reordered = structuredClone(actual); [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  await rejects('ordered selection preserved', reordered, /selection or order/);
  const missingJVM = actual.filter(row => !row.path.startsWith('compiler-port-jvm-descriptor-signatures/'));
  await rejects('JVM signature island cannot be removed', missingJVM, /Complete 3571-source/);
  const metadata = structuredClone(actual); delete metadata[0].compile;
  await rejects('complete row metadata required', metadata, /metadata and key order/);
  const aliasRows = structuredClone(actual), target = aliasRows.find(row => row.path === UTILS);
  target.filename = path.join(parent, 'aliased-utils.kt');
  await writeFile(target.filename, await readRegular(actual.find(row => row.path === UTILS).filename), { flag: 'wx', mode: 0o600 });
  await rejects('same-byte alias owner rejected', aliasRows, /Noncanonical PSI source owner/);
  async function mutation(name, logical, from, to) {
    const rows = structuredClone(actual), row = rows.find(row => row.path === logical), original = await readRegular(row.filename);
    const text = original.toString(); assert(text.includes(from));
    const changed = Buffer.from(text.replace(from, to));
    try {
      await writeFile(row.filename, changed); row.bytes = changed.length; row.sha256 = sha256(changed);
      await rejects(name, rows, /Actual PSI source body changed/);
    } finally { await writeFile(row.filename, original); }
  }
  await mutation('source getter evaluation cannot be replaced with a stub', UTILS,
    'get() = when (source) {', 'get() = when (null as KtSourceElement?) {');
  await mutation('offset fake-kind semantics remain exact', OFFSETS,
    'KtFakeSourceElementKind.ImplicitThisReceiverExpression', 'KtFakeSourceElementKind.ImplicitContextParameterArgument');
  await mutation('file path priority remains exact', CONVERTER,
    'file.sourceFile?.path ?: file.sourceFile?.name ?: file.name', 'file.sourceFile?.name ?: file.sourceFile?.path ?: file.name');
  await mutation('metadata value forwarding remains exact', METADATA,
    'override val isConst:', 'override val isConstChanged:');
  await mutation('prior exception implementation cannot be silently changed', UTILS,
    'if (isVirtualMachineError(throwable)) throw throwable', 'if (false) throw throwable');
  await verify(actual);
  for (const pin of toolInputs) {
    const bytes = await readRegular(pin.filename);
    assert.deepEqual({ bytes: bytes.length, sha256: sha256(bytes) }, { bytes: pin.bytes, sha256: pin.sha256 });
  }
  await writeFile(path.join(parent, 'guards.json'), JSON.stringify({ kind: 'fir-psi-source-mutation-guards',
    cases: rejected.map(name => ({ name, rejected: true })), restoredSourceState: true, actualSources: actual.length,
    sourceLockSha256: sha256(lockBytes), selectionLockSha256: sha256(selectionBytes), toolInputs, toolInputsUnchanged: true,
    exactPreviousExceptionInverse: true, fullFirToIrWasmExecuted: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ guardReceipt: path.join(parent, 'guards.json'), rejected: rejected.length, sources: actual.length }));
});
