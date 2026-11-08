import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { compilerInputPins, projectControlArguments } from '../compiler-exception-attachment-profile/current-foundation-control.mjs';
import { checked, reopenPsiBuild, reopenPsiNativeModuleContracts } from '../fir-lighttree-psi-views/verify.mjs';
import { compareTowerDiagnostics } from './diagnostics.mjs';
import { TARGET } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const logical = rows => rows.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));

export async function verifyTowerCompilerInputs(current, baseline) {
  assert(current.towerFinal && current.towerOptions, 'Actual tower map composition is required');
  assert.equal(current.actual.length, 3571); assert.equal(baseline.actual.length, 3571);
  assert.deepEqual(logical(current.towerFinal.predecessorRetainedSources), logical(baseline.actual),
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

export async function verifyTowerEvidence(evidence) {
  assert.equal(evidence.kind, 'fir-tower-private-mode-map-current-foundation-v1');
  assert.equal(evidence.result, 'pass');
  assert.equal(evidence.fullCompilerBuilt, false); assert.equal(evidence.publicLanguageSupport, false);
  const sourceLock = await checked(evidence.sourceLock);
  assert.deepEqual(sourceLock, await readRegular(path.join(here, 'sources.lock.json')));
  const previousFile = path.join(here, '../fir-lighttree-psi-views/evidence/current-foundation-v1.json');
  const previousBytes = await readRegular(previousFile), previous = JSON.parse(previousBytes);
  assert.deepEqual(identity(previousBytes), { bytes: evidence.baselineQualification.bytes, sha256: evidence.baselineQualification.sha256 });
  assert.equal(evidence.baselineQualification.filename, previousFile);
  assert.equal(previous.result, 'pass'); assert.deepEqual(evidence.baseline, previous.build);
  const oldVerifier = path.join(previous.build.snapshotRoot, 'producer/kotlin-browser/compiler-port/fir-lighttree-psi-views/verify.mjs');
  const oldPin = previous.shippingInputs.find(pin => pin.filename === oldVerifier); assert(oldPin);
  await checked(oldPin);
  const oldApi = await import(pathToFileURL(oldVerifier));
  const baseline = await oldApi.reopenPsiBuild(previous.build);
  await oldApi.reopenPsiNativeModuleContracts(baseline);
  const current = await reopenPsiBuild(evidence.build);
  assert(current.towerOptions && current.towerFinal);
  await reopenPsiNativeModuleContracts(current);
  const compilerComparison = await verifyTowerCompilerInputs(current, baseline);
  const diagnostics = await compareTowerDiagnostics(evidence.build.buildRoot, evidence.build.log.filename,
    previous.build.buildRoot, previous.build.log.filename);
  assert.deepEqual(JSON.parse(await checked(evidence.diagnostics)), diagnostics);
  const inventory = JSON.parse(await checked(evidence.frozenInputs));
  assert.deepEqual(inventory.argv, current.state.argv);
  assert.equal(inventory.cwd, evidence.build.snapshotRoot);
  assert(Array.isArray(inventory.inputs) && inventory.inputs.length > 10000);
  for (const pin of inventory.inputs) await checked(pin);
  assert.equal(current.state.frozenInputsUnchanged, true); assert.deepEqual(current.state.changedInputs, []);
  assert.equal(evidence.build.snapshotRoot, path.resolve(here, '../../../..'));
  for (const pin of evidence.shippingInputs) await checked(pin);
  for (const file of ['verify.mjs', 'diagnostics.mjs', 'transform.mjs', 'prepare.mjs', 'sources.lock.json', 'selection.lock.json',
    'runtime-probe.mjs', '../build.mjs', '../fir-lighttree-psi-views/verify.mjs', '../native-js-output-profile/phase-boundary.mjs']) {
    const filename = path.resolve(here, file);
    const pin = evidence.shippingInputs.find(item => item.filename === filename); assert(pin, 'Missing executed tool: ' + file);
    assert.deepEqual(await checked(pin), await readRegular(filename, 128 * 1024 * 1024));
  }
  const runtimeStatus = JSON.parse(await checked(evidence.runtime.status));
  assert.equal(runtimeStatus.state, 'exited'); assert.equal(runtimeStatus.exitCode, 0);
  assert.equal(runtimeStatus.sourceInputsUnchanged, true);
  assert.equal(runtimeStatus.cwd, evidence.build.snapshotRoot);
  assert(runtimeStatus.finishedUnix <= current.state.startedUnix, 'Runtime and whole compiler must run serially');
  await checked(evidence.runtime.log); await checked(evidence.runtime.receipt);
  const runtimeApi = await import('./runtime-probe.mjs');
  const runtime = await runtimeApi.verifyTowerRuntime(evidence.runtime.receipt.filename);
  assert.equal(runtimeStatus.argv[0], 'node'); assert.equal(runtimeStatus.argv[1], path.join(here, 'runtime-probe.mjs'));
  assert.equal(runtimeStatus.argv[2], runtime.receipt.sourceRoot);
  assert.equal(runtimeStatus.argv[3], previous.build.buildRoot);
  assert.equal(runtimeStatus.argv[4], path.dirname(evidence.runtime.receipt.filename));
  assert.deepEqual(evidence.checks.map(group => group.kind), ['source', 'diagnostics']);
  for (const group of evidence.checks) {
    const status = JSON.parse(await checked(group.status));
    assert.equal(status.exitCode, 0);
    let argv, cwd, inputPins;
    if (group.kind === 'source') {
      assert.equal(status.kind, 'fir-tower-mode-map-source-guard-job');
      assert.equal(status.status, 'completed'); assert(status.finished >= status.started);
      assert.equal(status.inputsUnchanged, true); assert.deepEqual(status.inputsBefore, status.inputsAfter);
      argv = status.argv; cwd = status.cwd; inputPins = status.inputsBefore;
      assert.equal(status.log, group.log.filename);
    } else {
      assert.equal(status.kind, 'fir-tower-diagnostic-unit-status');
      assert.equal(status.state, 'exited'); assert(status.finishedUnix >= status.startedUnix);
      assert.equal(status.frozenInputsUnchanged, true); assert.deepEqual(status.changedInputs, []);
      assert.deepEqual(status.inputHashesBefore, status.inputHashesAfter);
      const input = JSON.parse(await checked(status.inputs));
      assert.equal(input.kind, 'fir-tower-diagnostic-unit-inputs');
      argv = input.argv; cwd = input.cwd; inputPins = status.inputHashesBefore;
      assert.deepEqual(status.log, group.log);
    }
    assert(Array.isArray(inputPins) && inputPins.length > 0);
    for (const pin of inputPins) await checked(pin);
    const testFile = path.join(here, group.kind === 'source' ? 'prepare.test.mjs' : 'diagnostics.test.mjs');
    assert.deepEqual(argv, ['node', '--test', '--test-reporter=tap', testFile]);
    assert.equal(cwd, evidence.build.snapshotRoot);
    const testPin = evidence.shippingInputs.find(pin => pin.filename === testFile); assert(testPin);
    assert.deepEqual(await checked(testPin), await readRegular(testFile));
    const log = (await checked(group.log)).toString();
    assert.match(log, /# fail 0(?:\r?\n|$)/);
    assert.match(log, /# skipped 0(?:\r?\n|$)/);
    if (group.receipt) await checked(group.receipt);
  }
  assert(evidence.checks.length >= 2, 'Source and diagnostic regression checks are required');
  return { result: 'pass', compilerComparison, runtime,
    sourceInventoryFiles: inventory.inputs.length,
    diagnostics, fullCompilerBuilt: false, wholeFirResolutionExecuted: false, publicLanguageSupport: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const filename = path.resolve(process.argv[2] ?? path.join(here, 'evidence/current-foundation-v1.json'));
  const result = await verifyTowerEvidence(JSON.parse(await readRegular(filename)));
  console.log(JSON.stringify({ result: result.result, compilerComparison: result.compilerComparison,
    sourceInventoryFiles: result.sourceInventoryFiles, fullCompilerBuilt: false, publicLanguageSupport: false }));
}
