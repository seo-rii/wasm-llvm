import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { actualPredecessor } from './fixture.mjs';
import { comparePsiDiagnostics } from './diagnostics.mjs';
import { reopenPsiBuild, compareAuthenticCompilerInputs } from './verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
async function pin(filename) {
  filename = path.resolve(filename); const bytes = await readRegular(filename, 128 * 1024 * 1024);
  return { filename, bytes: bytes.length, sha256: sha256(bytes) };
}
async function freshJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

export async function sealPsiEvidence(configuration) {
  const build = await reopenPsiBuild(configuration.build);
  const baseline = await actualPredecessor(configuration.baselineRoot);
  const compilerComparison = await compareAuthenticCompilerInputs(build, baseline);
  const qualificationPath = path.join(here, '../compiler-exception-attachment-profile/evidence/current-foundation-v4.json');
  const qualification = JSON.parse(await readRegular(qualificationPath));
  const diagnostics = await comparePsiDiagnostics(configuration.build.buildRoot, configuration.build.log.filename,
    baseline.buildRoot, qualification.build.log.filename);
  assert.equal(diagnostics.baselineTotal, 1307);
  assert.equal(diagnostics.baselineProfileEntries.length, 52);
  assert.equal(diagnostics.currentTotal, 1262); assert.equal(diagnostics.currentProfileEntries.length, 10);
  assert.deepEqual(diagnostics.newProfileDiagnosticEntries, []);
  assert.equal(diagnostics.newOtherDiagnosticEntries.length, 9);
  assert.equal(diagnostics.reviewedDrift.reviewedNewDiagnosticEntries.length, 9);
  assert.deepEqual(diagnostics.reviewedDrift.unreviewedNewDiagnosticEntries, []);
  await freshJson(configuration.diagnosticsFile, diagnostics);
  const outputFiles = [];
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      const filename = path.join(directory, name), info = await lstat(filename);
      assert(!info.isSymbolicLink(), 'Frozen output cannot contain a symlink');
      if (info.isDirectory()) await visit(filename);
      else { assert(info.isFile()); outputFiles.push(filename); }
    }
  }
  await visit(configuration.build.buildRoot);
  const records = [];
  for (const filename of outputFiles.sort()) {
    const { bytes, sha256 } = await pin(filename);
    records.push({ path: path.relative(configuration.build.snapshotRoot, filename), bytes, sha256 });
  }
  await freshJson(configuration.outputInventoryFile, { kind: 'fir-psi-actual-whole-output-inventory',
    sourceRoot: configuration.build.snapshotRoot, buildRoot: configuration.build.buildRoot, records });
  const tools = ['../build.mjs', '../native-js-output-profile/phase-boundary.mjs',
    '../native-js-output-profile/update-recipe.mjs', '../native-js-output-profile/sources.lock.json'];
  for (const name of await readdir(here)) if (/\.(?:mjs|json|kt|in)$/.test(name) && (await lstat(path.join(here, name))).isFile()) tools.push(name);
  const shippingInputs = [];
  for (const name of tools.sort()) shippingInputs.push(await pin(path.resolve(here, name)));
  async function record(description) {
    const result = {};
    for (const [name, filename] of Object.entries(description)) result[name] = await pin(filename);
    return result;
  }
  const evidence = { schemaVersion: 1, kind: 'fir-lighttree-psi-current-foundation-evidence-v1', result: 'pass',
    sourceLock: await pin(path.join(here, 'sources.lock.json')), selectionLock: await pin(path.join(here, 'selection.lock.json')),
    shippingInputs, build: configuration.build,
    baseline: { buildRoot: baseline.buildRoot, qualification: await pin(qualificationPath), log: qualification.build.log.filename },
    compilerComparison, frozenInputs: await pin(configuration.frozenInputs), outputInventory: await pin(configuration.outputInventoryFile),
    runtime: await record(configuration.runtime), guards: await record(configuration.guards), wholeGuards: await record(configuration.wholeGuards),
    diagnosticDriftLock: await pin(path.join(here, 'diagnostic-drift.lock.json')), driftGuards: await record(configuration.driftGuards),
    diagnostics: await pin(configuration.diagnosticsFile),
    validationScope: 'Actual whole 3571-source compiler invocation, authentic predecessor diagnostic comparison, exact source inverses, native/module reopening and genuine JVM plus common/Wasm method-boundary observations',
    fullCompilerBuilt: false, fullFirToIrWasmExecuted: false, publicLanguageSupport: false };
  await freshJson(configuration.evidenceFile, evidence);
  return { evidenceFile: configuration.evidenceFile, compilerComparison, baselineDiagnostics: diagnostics.baselineTotal,
    currentDiagnostics: diagnostics.currentTotal, profileDiagnostics: diagnostics.currentProfileEntries.length,
    rawNewOtherDiagnostics: 9, reviewedDiagnosticDrift: 9, unreviewedNewDiagnostics: 0,
    outputFiles: records.length, verificationPending: true };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv[2], 'Pass a completed current-foundation evidence configuration');
  console.log(JSON.stringify(await sealPsiEvidence(JSON.parse(await readRegular(path.resolve(process.argv[2]))))));
}
