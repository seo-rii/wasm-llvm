import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNoSymlink, readRegular, sha256 } from '../../scripts/source.mjs';
import { compilerInputPins, projectControlArguments } from '../compiler-exception-attachment-profile/current-foundation-control.mjs';
import { checked, reopenPsiBuild, reopenPsiNativeModuleContracts } from '../fir-lighttree-psi-views/verify.mjs';
import { compareMainDiagnostics } from './diagnostics.mjs';
import { TARGET } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const logical = rows => rows.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));

// The frozen source-check inventory also contains the real Chromium executable.
// Reopen large tool binaries without inflating the proof reader's memory usage.
async function verifyPinnedFile(pin) {
  assert(Number.isSafeInteger(pin.bytes) && pin.bytes >= 0 && /^[a-f0-9]{64}$/.test(pin.sha256 ?? ''));
  if (pin.bytes <= 128 * 1024 * 1024) { await checked(pin); return; }
  await assertNoSymlink(pin.filename);
  const handle = await open(pin.filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); assert(stat.isFile()); assert.equal(stat.size, pin.bytes);
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { bytes += chunk.length; hash.update(chunk); }
    assert.equal(bytes, pin.bytes); assert.equal(hash.digest('hex'), pin.sha256, 'Evidence changed: ' + pin.filename);
  } finally { await handle.close(); }
}

export async function verifyMainCompilerInputs(current, baseline) {
  assert(current.mainEntryFinal && current.mainEntryOptions, 'Actual official entry composition is required');
  assert.equal(current.actual.length, 3571); assert.equal(baseline.actual.length, 3571);
  assert.deepEqual(logical(current.mainEntryFinal.predecessorRetainedSources), logical(baseline.actual),
    'The complete one-file inverse must equal the actual qualified predecessor');
  const changed = current.actual.filter((row, index) => row.sha256 !== baseline.actual[index].sha256);
  assert.deepEqual(changed.map(row => row.path), [TARGET]);
  assert.equal(current.actual.filter(row => row.path.startsWith('compiler-port-jvm-descriptor-signatures/')).length, 18);
  assert.deepEqual(current.receipt.bootstrap, baseline.receipt.bootstrap);
  const currentPins = await compilerInputPins(current.command.command, current.args, current.receipt.bootstrap, current.receipt.hostLibraries);
  const baselinePins = await compilerInputPins(baseline.command.command, baseline.args, baseline.receipt.bootstrap, baseline.receipt.hostLibraries);
  const normalized = pins => pins.map(({ filename, ...pin }) => ({ filename: path.basename(filename), ...pin }));
  assert.deepEqual(normalized(currentPins), normalized(baselinePins), 'Compiler or host library contents changed');
  const command = value => {
    const copy = [...value], index = copy.indexOf('-cp'); assert(index >= 0);
    copy[index + 1] = copy[index + 1].split(path.delimiter).map(file => path.basename(file)).join(path.delimiter);
    copy[copy.length - 1] = '@<authenticated-source-and-output-vector>';
    return copy;
  };
  assert.deepEqual(command(current.command.command), command(baseline.command.command));
  for (const key of ['maximumHeap', 'timeoutMs']) assert.equal(current.command[key], baseline.command[key]);
  const projected = projectControlArguments(current.args, current.actual, baseline.actual, baseline.description.buildRoot);
  const libraries = projected.indexOf('-libraries');
  assert(libraries >= 0); assert.equal(baseline.args.indexOf('-libraries'), libraries);
  projected[libraries + 1] = baseline.args[libraries + 1];
  assert.deepEqual(projected, baseline.args, 'Non-source compiler arguments changed');
  return { orderedSources: 3571, unchangedSources: 3570, changedSource: TARGET,
    retainedJvmSignatureSources: 18, compilerAndLibraryFiles: currentPins.length,
    completeInverseEqualsBaseline: true, compilerLibrariesAndOptionsUnchanged: true,
    baselineExitCode: baseline.command.exitCode, currentExitCode: current.command.exitCode };
}

export async function verifyMainEvidence(evidence) {
  assert.equal(evidence.kind, 'official-main-entry-current-foundation-v1');
  assert.equal(evidence.result, 'pass');
  assert.equal(evidence.fullCompilerBuilt, false); assert.equal(evidence.publicLanguageSupport, false);
  assert.equal(evidence.browserKotlinCompilation, false); assert.equal(evidence.wholeFirResolutionExecuted, false);
  const sourceLock = await checked(evidence.sourceLock);
  assert.deepEqual(sourceLock, await readRegular(path.join(here, 'sources.lock.json')));
  const previousFile = path.join(here, '../fir-tower-mode-map/evidence/current-foundation-v1.json');
  const previousBytes = await readRegular(previousFile), previous = JSON.parse(previousBytes);
  assert.deepEqual(identity(previousBytes), { bytes: evidence.baselineQualification.bytes, sha256: evidence.baselineQualification.sha256 });
  assert.equal(evidence.baselineQualification.filename, previousFile);
  assert.equal(previous.result, 'pass'); assert.deepEqual(evidence.baseline, previous.build);
  for (const pin of evidence.shippingInputs) await checked(pin);
  for (const pin of previous.shippingInputs) await checked(pin);
  const previousInputs = JSON.parse(await checked(previous.frozenInputs));
  for (const pin of previousInputs.inputs) await verifyPinnedFile(pin);
  // This unchanged static import was absent from the prior execution inventory.
  // Bind its historical bytes to the pinned current helper before importing it.
  const fixture = path.join(here, '../fir-lighttree-psi-views/fixture.mjs');
  const fixturePin = evidence.shippingInputs.find(pin => pin.filename === path.resolve(fixture)); assert(fixturePin);
  const historicalFixture = path.join(previous.build.snapshotRoot, 'producer/kotlin-browser/compiler-port/fir-lighttree-psi-views/fixture.mjs');
  assert.deepEqual(await readRegular(historicalFixture), await checked(fixturePin));
  const oldVerifier = path.join(previous.build.snapshotRoot, 'producer/kotlin-browser/compiler-port/fir-lighttree-psi-views/verify.mjs');
  const oldPin = previous.shippingInputs.find(pin => pin.filename === oldVerifier); assert(oldPin);
  await checked(oldPin);
  const oldApi = await import(pathToFileURL(oldVerifier));
  const baseline = await oldApi.reopenPsiBuild(previous.build);
  await oldApi.reopenPsiNativeModuleContracts(baseline);
  const current = await reopenPsiBuild(evidence.build);
  assert(current.mainEntryOptions && current.mainEntryFinal);
  await reopenPsiNativeModuleContracts(current);
  const compilerComparison = await verifyMainCompilerInputs(current, baseline);
  const diagnostics = await compareMainDiagnostics(evidence.build.buildRoot, evidence.build.log.filename,
    previous.build.buildRoot, previous.build.log.filename);
  assert.deepEqual(JSON.parse(await checked(evidence.diagnostics)), diagnostics);
  const inventory = JSON.parse(await checked(evidence.frozenInputs));
  assert.deepEqual(inventory.argv, current.state.argv);
  assert.equal(inventory.cwd, evidence.build.snapshotRoot);
  assert.equal(inventory.log, evidence.build.log.filename); assert.equal(current.state.log, inventory.log);
  assert(Array.isArray(inventory.inputs) && inventory.inputs.length > 10000);
  for (const pin of inventory.inputs) await verifyPinnedFile(pin);
  assert.equal(current.state.frozenInputsUnchanged, true); assert.deepEqual(current.state.changedInputs, []);
  assert.equal(evidence.build.snapshotRoot, path.resolve(here, '../../../..'));
  for (const file of ['verify.mjs', 'diagnostics.mjs', 'transform.mjs', 'prepare.mjs', 'sources.lock.json', 'selection.lock.json',
    'runtime-probe.mjs', '../build.mjs', '../fir-lighttree-psi-views/verify.mjs', '../native-js-output-profile/phase-boundary.mjs']) {
    const filename = path.resolve(here, file);
    const pin = evidence.shippingInputs.find(item => item.filename === filename); assert(pin, 'Missing executed tool: ' + file);
    assert.deepEqual(await checked(pin), await readRegular(filename, 128 * 1024 * 1024));
  }
  const runtimeStatus = JSON.parse(await checked(evidence.runtime.status));
  const runtimeJob = JSON.parse(await checked(evidence.runtime.job));
  const runtimeConfig = JSON.parse(await checked(evidence.runtime.config));
  assert.equal(runtimeStatus.exitCode, 0); assert.equal(runtimeStatus.inputsUnchanged, true);
  assert(runtimeStatus.finished >= runtimeStatus.started && runtimeStatus.finished <= current.state.startedUnix,
    'Runtime must finish before whole-compiler execution');
  assert.equal(runtimeJob.cwd, evidence.build.snapshotRoot);
  assert.equal(runtimeJob.log, evidence.runtime.log.filename); assert.equal(runtimeStatus.log, runtimeJob.log);
  assert.deepEqual(runtimeStatus.inputsAfter, runtimeJob.inputs);
  for (const pin of runtimeJob.inputs) await checked(pin);
  assert.deepEqual(runtimeJob.argv, ['node', path.join(here, 'runtime-probe.mjs'), evidence.runtime.config.filename]);
  assert.equal(path.dirname(evidence.runtime.receipt.filename), runtimeConfig.outputRoot);
  const configPin = runtimeJob.inputs.find(pin => pin.filename === evidence.runtime.config.filename); assert(configPin);
  assert.deepEqual(configPin, evidence.runtime.config);
  await checked(evidence.runtime.log); await checked(evidence.runtime.receipt);
  const runtimeApi = await import('./runtime-probe.mjs');
  const runtime = await runtimeApi.verifyMainRuntime(evidence.runtime.receipt.filename);
  const integrity = evidence.runtimeIntegrity;
  const integrityJob = JSON.parse(await checked(integrity.job)), integrityStatus = JSON.parse(await checked(integrity.status));
  assert.equal(integrityStatus.exitCode, 0); assert.equal(integrityStatus.inputsUnchanged, true);
  assert(integrityStatus.finished >= integrityStatus.started && integrityStatus.started >= runtimeStatus.finished);
  assert.equal(integrityJob.cwd, evidence.build.snapshotRoot);
  assert.equal(integrityJob.log, integrity.log.filename); assert.equal(integrityStatus.log, integrityJob.log);
  assert.deepEqual(integrityJob.environment, { OFFICIAL_MAIN_RUNTIME_RECEIPT: evidence.runtime.receipt.filename });
  const integrityTests = ['runtime.test.mjs', 'runtime-integrity.test.mjs'].map(file => path.join(here, file));
  assert.deepEqual(integrityJob.argv, ['node', '--test', '--test-reporter=tap', ...integrityTests]);
  assert.deepEqual(integrityStatus.inputsAfter, integrityJob.inputs);
  const runtimeReceipt = JSON.parse(await checked(evidence.runtime.receipt));
  const expectedIntegrityInputs = [...runtimeReceipt.inputPins, evidence.runtime.receipt,
    ...integrityTests.map(filename => { const pin = evidence.shippingInputs.find(row => row.filename === filename); assert(pin); return pin; })];
  const byFilename = rows => rows.slice().sort((a, b) => a.filename.localeCompare(b.filename));
  assert.deepEqual(byFilename(integrityJob.inputs), byFilename(expectedIntegrityInputs));
  for (const pin of integrityJob.inputs) await verifyPinnedFile(pin);
  for (const filename of integrityTests) {
    const shipped = evidence.shippingInputs.find(pin => pin.filename === filename); assert(shipped);
    assert.deepEqual(integrityJob.inputs.find(pin => pin.filename === filename), shipped);
  }
  const integrityLog = (await checked(integrity.log)).toString();
  for (const name of ['fail', 'skipped', 'cancelled']) assert.match(integrityLog, new RegExp('# ' + name + ' 0(?:\\r?\\n|$)'));
  assert.match(integrityLog, /# tests 78(?:\r?\n|$)/);
  const guards = JSON.parse(await checked(integrity.receipt));
  assert.equal(guards.kind, 'official-main-actual-runtime-integrity-guards'); assert.equal(guards.result, 'pass');
  assert.deepEqual(guards.completedReceipt, evidence.runtime.receipt);
  assert.equal(guards.originalEvidenceUnmodified, true); assert.deepEqual(guards.actualInputsAndArtifactsReopened, runtime);
  assert.equal(guards.cases.length, 32); assert(guards.cases.every(row => row.rejected === true));
  assert.deepEqual(evidence.checks.map(group => group.kind), ['source', 'diagnostics']);
  for (const group of evidence.checks) {
    const status = JSON.parse(await checked(group.status));
    assert.equal(status.exitCode, 0);
    let argv, cwd, inputPins;
    if (group.kind === 'source') {
      assert.equal(status.kind, 'official-main-entry-frozen-job');
      assert.equal(status.result, 'pass'); assert.equal(status.inputsUnchanged, true);
      assert.deepEqual(status.changed, []);
      assert.equal(status.inputs, group.inputs.filename);
      const frozen = JSON.parse(await checked(group.inputs));
      assert.equal(frozen.cwd, status.cwd); assert.deepEqual(frozen.argv, status.argv);
      inputPins = frozen.inputs;
      assert.equal(inputPins.length, status.inputCount);
      argv = status.argv; cwd = status.cwd;
      assert.equal(status.log, group.log.filename);
    } else {
      assert.equal(status.state, 'exited'); assert(status.finishedUnix >= status.startedUnix);
      assert.equal(status.frozenInputsUnchanged, true); assert.deepEqual(status.changedInputs, []);
      const job = JSON.parse(await checked(group.job));
      argv = job.argv; cwd = job.cwd; inputPins = job.inputs;
      assert.deepEqual(status.argv, job.argv); assert.equal(status.sourceRoot, job.cwd);
      assert.equal(job.status, group.status.filename);
      assert.equal(status.log, group.log.filename); assert.equal(job.log, group.log.filename);
    }
    assert(Array.isArray(inputPins) && inputPins.length > 0);
    for (const pin of inputPins) await verifyPinnedFile(pin);
    const testFile = path.join(here, group.kind === 'source' ? 'prepare.test.mjs' : 'diagnostics.test.mjs');
    assert.deepEqual(argv, ['node', '--test', '--test-reporter=tap', testFile]);
    assert.equal(cwd, evidence.build.snapshotRoot);
    const testPin = evidence.shippingInputs.find(pin => pin.filename === testFile); assert(testPin);
    const executedTestPin = inputPins.find(pin => pin.filename === testFile); assert(executedTestPin);
    assert.deepEqual(executedTestPin, testPin);
    assert.deepEqual(await checked(testPin), await readRegular(testFile));
    const log = (await checked(group.log)).toString();
    assert.match(log, /# fail 0(?:\r?\n|$)/);
    assert.match(log, /# skipped 0(?:\r?\n|$)/);
    if (group.receipt) await checked(group.receipt);
  }
  assert(evidence.checks.length >= 2, 'Source and diagnostic regression checks are required');
  return { result: 'pass', compilerComparison, runtime, runtimeIntegrityGuards: guards.cases.length,
    sourceInventoryFiles: inventory.inputs.length,
    diagnostics, fullCompilerBuilt: false, browserKotlinCompilation: false, wholeFirResolutionExecuted: false, publicLanguageSupport: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const filename = path.resolve(process.argv[2] ?? path.join(here, 'evidence/current-foundation-v1.json'));
  const result = await verifyMainEvidence(JSON.parse(await readRegular(filename)));
  console.log(JSON.stringify({ result: result.result, compilerComparison: result.compilerComparison,
    sourceInventoryFiles: result.sourceInventoryFiles, fullCompilerBuilt: false, publicLanguageSupport: false }));
}
