import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256 } from '../../scripts/source.mjs';
import { reopenPsiBuild, reopenPsiNativeModuleContracts } from '../fir-lighttree-psi-views/verify.mjs';
import { compareDequeDiagnostics } from './diagnostics.mjs';
import { TARGETS } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const configurationKeys = ['snapshotRoot', 'buildRoot', 'status', 'log', 'job', 'baselineSelection', 'baselineLog',
  'runtimeReceipt', 'coreGuards', 'diagnosticGuards', 'validationJob', 'validationStatus', 'validationLog',
  'diagnosticsFile', 'evidenceFile', 'snapshotManifest'];
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const canonical = filename => {
  assert(typeof filename === 'string' && path.isAbsolute(filename) && path.resolve(filename) === filename,
    'Canonical absolute evidence path required');
  return filename;
};
const contained = (root, filename) => filename.startsWith(root + path.sep);

async function load(filename, maximum = 128 * 1024 * 1024) {
  const bytes = await readRegular(canonical(filename), maximum);
  return { bytes, value: JSON.parse(bytes), pin: { filename, ...identity(bytes) } };
}

export async function verifyDequePinnedFile(pin) {
  canonical(pin.filename);
  assert(Number.isSafeInteger(pin.bytes) && pin.bytes >= 0 && /^[a-f0-9]{64}$/.test(pin.sha256 ?? ''), 'Invalid evidence pin');
  await assertNoSymlink(pin.filename);
  const handle = await open(pin.filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); assert(stat.isFile()); assert.equal(stat.size, pin.bytes);
    const hash = createHash('sha256'); let count = 0;
    for await (const bytes of handle.createReadStream({ autoClose: false })) { hash.update(bytes); count += bytes.length; }
    assert.equal(count, pin.bytes); assert.equal(hash.digest('hex'), pin.sha256, 'Evidence changed: ' + pin.filename);
  } finally { await handle.close(); }
}

async function pinFile(filename) {
  const bytes = await readRegular(canonical(filename), 128 * 1024 * 1024);
  return { filename, ...identity(bytes) };
}

export function normalizeDequeEvidenceConfiguration(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input));
  assert(Object.keys(input).every(key => configurationKeys.includes(key)), 'Unknown evidence configuration field');
  const result = { ...input,
    diagnosticsFile: input.diagnosticsFile ?? path.join(repository, 'out/continue-20261111/control/diagnostics-qualified-v1.json'),
    evidenceFile: input.evidenceFile ?? path.join(here, 'evidence/current-foundation-v1.json') };
  for (const key of configurationKeys) if (key !== 'snapshotManifest' || result[key] !== undefined) canonical(result[key]);
  if (result.snapshotRoot !== repository) {
    assert(result.snapshotManifest, 'A separate build snapshot requires its authenticated copy manifest');
    assert(!contained(repository, result.snapshotRoot) && !contained(result.snapshotRoot, repository), 'Snapshot and review roots must be disjoint');
  }
  if (result.snapshotManifest) assert(contained(path.join(repository, 'out'), result.snapshotManifest));
  assert(contained(path.join(result.snapshotRoot, 'out'), result.buildRoot));
  assert(contained(path.join(repository, 'out'), result.diagnosticsFile));
  assert(contained(path.join(here, 'evidence'), result.evidenceFile));
  const references = configurationKeys.filter(key => result[key] !== undefined &&
    !['snapshotRoot', 'buildRoot', 'diagnosticsFile', 'evidenceFile'].includes(key));
  assert.equal(new Set(references.map(key => result[key])).size, references.length, 'Evidence inputs must have distinct owners');
  for (const key of references) assert(![result.diagnosticsFile, result.evidenceFile].includes(result[key]), 'Evidence output overlaps input');
  assert(!contained(result.buildRoot, result.diagnosticsFile), 'Diagnostic report must not alter the completed build inventory');
  assert(!contained(path.dirname(result.runtimeReceipt), result.diagnosticsFile), 'Diagnostic report must not alter the completed runtime inventory');
  return result;
}

async function shippingPins() {
  const local = (await readdir(here, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.(mjs|json|kt)$/.test(entry.name)).map(entry => entry.name);
  for (const required of ['prepare.mjs', 'prepare.test.mjs', 'transform.mjs', 'sources.lock.json', 'selection.lock.json',
    'diagnostics.mjs', 'diagnostics.test.mjs', 'runtime-probe.mjs', 'verify.mjs', 'seal.mjs']) assert(local.includes(required));
  const names = [...local, '../build.mjs', '../fir-lighttree-psi-views/verify.mjs',
    '../native-js-output-profile/phase-boundary.mjs', '../native-js-output-profile/update-recipe.mjs',
    '../native-js-output-profile/sources.lock.json'];
  return Promise.all(names.sort().map(name => pinFile(path.resolve(here, name))));
}

async function bindReviewableSnapshot(config, job, shipping) {
  if (config.snapshotRoot === repository && !config.snapshotManifest)
    return { summary: { sourceRoot: repository, snapshotRoot: repository, separateSnapshot: false }, pins: [] };
  const opened = await load(config.snapshotManifest, 64 * 1024 * 1024), manifest = opened.value;
  assert.equal(manifest.sourceRoot, repository); assert.equal(manifest.snapshotRoot, config.snapshotRoot);
  assert.equal(manifest.sourceRowsUnchanged, true);
  assert(Array.isArray(manifest.records) && manifest.records.length > 0);
  const records = new Map();
  for (const row of manifest.records) {
    relativePath(row.path); assert(!records.has(row.path), 'Duplicate snapshot source path');
    assert.equal(row.source, path.join(repository, row.path));
    assert.equal(row.snapshot, path.join(config.snapshotRoot, row.path));
    assert(Number.isSafeInteger(row.bytes) && row.bytes >= 0 && /^[a-f0-9]{64}$/.test(row.sha256 ?? ''));
    records.set(row.path, row);
  }
  for (let offset = 0; offset < manifest.records.length; offset += 12) {
    const batch = await Promise.allSettled(manifest.records.slice(offset, offset + 12).map(async row => {
      await verifyDequePinnedFile({ filename: row.source, bytes: row.bytes, sha256: row.sha256 });
      await verifyDequePinnedFile({ filename: row.snapshot, bytes: row.bytes, sha256: row.sha256 });
    }));
    for (const result of batch) if (result.status !== 'fulfilled') throw result.reason;
  }
  const buildSourceInputs = job.inputs.filter(pin => contained(path.join(config.snapshotRoot, 'producer/kotlin-browser'), pin.filename));
  assert(buildSourceInputs.length > 0, 'Frozen snapshot compiler producer inputs required');
  for (const pin of buildSourceInputs) {
    const relative = path.relative(config.snapshotRoot, pin.filename), row = records.get(relative);
    assert(row, 'Frozen producer file is absent from the reviewed source snapshot: ' + relative);
    assert.deepEqual({ bytes: pin.bytes, sha256: pin.sha256 }, { bytes: row.bytes, sha256: row.sha256 });
  }
  for (const pin of shipping) {
    const relative = path.relative(repository, pin.filename), row = records.get(relative);
    assert(row, 'Current proof tool is absent from the final source snapshot: ' + relative);
    assert.deepEqual({ bytes: pin.bytes, sha256: pin.sha256 }, { bytes: row.bytes, sha256: row.sha256 });
  }
  return { summary: { sourceRoot: repository, snapshotRoot: config.snapshotRoot,
    separateSnapshot: config.snapshotRoot !== repository, manifest: opened.pin,
    copiedRegularFilesReopenedInBothRoots: manifest.records.length,
    frozenProducerFilesMatchReviewableSources: buildSourceInputs.length, allProofToolsMatchSnapshot: true }, pins: [opened.pin] };
}

export async function verifyDequeValidation(config) {
  const job = await load(config.validationJob), status = await load(config.validationStatus);
  const guards = await load(config.coreGuards), sourceLock = await load(path.join(here, 'sources.lock.json'));
  assert.equal(status.value.state, 'exited'); assert.equal(status.value.exitCode, 0);
  assert.equal(status.value.frozenInputsUnchanged, true); assert.deepEqual(status.value.changedInputs, []);
  assert.equal(status.value.configSha256, job.pin.sha256);
  assert.equal(status.value.sourceRoot, repository); assert.equal(job.value.cwd, repository);
  assert.equal(job.value.status, config.validationStatus); assert.equal(job.value.log, config.validationLog);
  assert.equal(status.value.log, config.validationLog); assert.deepEqual(status.value.argv, job.value.argv);
  assert(Number.isFinite(status.value.startedUnix) && Number.isFinite(status.value.finishedUnix) &&
    status.value.finishedUnix >= status.value.startedUnix, 'Completed validation timestamps required');
  const testFiles = ['prepare.test.mjs', 'diagnostics.test.mjs'].map(name => path.join(here, name));
  assert.deepEqual(job.value.argv, ['node', '--test', ...testFiles], 'Validation must execute exactly the two recorded source/diagnostic test files');
  assert.deepEqual(job.value.environment, {
    KOTLIN_COMMON_DEQUE_BASELINE: config.baselineSelection,
    KOTLIN_COMMON_DEQUE_SOURCE_ROOT: guards.value.originalSourceRoot,
  });
  assert(Array.isArray(job.value.inputs) && job.value.inputs.length > 3571);
  assert.equal(status.value.inputCount, job.value.inputs.length);
  const frozen = new Map(job.value.inputs.map(pin => [pin.filename, pin]));
  assert.equal(frozen.size, job.value.inputs.length, 'Validation input inventory has duplicate owners');
  const requiredTools = ['prepare.test.mjs', 'diagnostics.test.mjs', 'prepare.mjs', 'diagnostics.mjs', 'transform.mjs',
    'sources.lock.json', 'selection.lock.json'].map(name => path.join(here, name));
  for (const filename of requiredTools) {
    const current = await pinFile(filename);
    assert.deepEqual(frozen.get(filename), current, 'Executed validation source changed or was not frozen: ' + filename);
  }
  for (const pin of sourceLock.value.dependencies) {
    const filename = path.resolve(here, pin.path), executed = frozen.get(filename); assert(executed, 'Missing frozen preparation dependency');
    assert.deepEqual({ bytes: executed.bytes, sha256: executed.sha256 }, { bytes: pin.bytes, sha256: pin.sha256 });
  }
  const baseline = await load(config.baselineSelection, 8 * 1024 * 1024);
  assert.deepEqual(frozen.get(config.baselineSelection), baseline.pin);
  assert.equal(baseline.value.retainedSources.length, 3571);
  for (const pin of baseline.value.retainedSources) assert.deepEqual(frozen.get(pin.filename),
    { filename: pin.filename, bytes: pin.bytes, sha256: pin.sha256 }, 'Validation omitted a complete selected baseline source');
  for (const row of sourceLock.value.files) {
    const filename = path.join(guards.value.originalSourceRoot, row.path);
    assert.deepEqual(frozen.get(filename), { filename, bytes: row.original.bytes, sha256: row.original.sha256 },
      'Validation omitted an original whole target source');
  }
  for (let offset = 0; offset < job.value.inputs.length; offset += 16) {
    const batch = await Promise.allSettled(job.value.inputs.slice(offset, offset + 16).map(verifyDequePinnedFile));
    for (const result of batch) if (result.status !== 'fulfilled') throw result.reason;
  }
  const logBytes = await readRegular(config.validationLog, 8 * 1024 * 1024), lines = logBytes.toString().split(/\r?\n/);
  // This actual Node 24 execution emitted the spec reporter. Preserve and
  // authenticate that raw output; do not normalize it into a synthetic TAP log.
  for (const [name, count] of Object.entries({ tests: 77, suites: 0, pass: 77, fail: 0, cancelled: 0, skipped: 0, todo: 0 })) {
    const summary = lines.filter(line => line.startsWith('ℹ ' + name + ' '));
    assert.deepEqual(summary, ['ℹ ' + name + ' ' + count], 'Validation raw Node spec summary changed: ' + name);
  }
  assert.equal(lines.filter(line => /^\s*✔ .+ \([\d.]+ms\)$/.test(line)).length, 77, 'All 77 individual tests must report success');
  assert(!lines.some(line => /^\s*✖ |^not ok |^Bail out!|^# (?:SKIP|TODO)/.test(line)), 'Validation log contains an explicit test failure/skip');
  assert.equal(lines.filter(line => /^✔ six complete official source adaptations retain exact inverses and the full selected graph \([\d.]+ms\)$/.test(line)).length, 1);
  const objects = lines.filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.deepEqual(objects.filter(value => Object.hasOwn(value, 'guardReceipt')),
    [{ guardReceipt: config.coreGuards, rejected: 27, sources: 3571 }], 'Source guard receipt was not emitted by this actual test run');
  assert.deepEqual(objects.filter(value => Object.hasOwn(value, 'frozenInputsUnchanged')),
    [{ exitCode: 0, frozenInputsUnchanged: true, status: config.validationStatus }], 'Validation log footer is not bound to the completed frozen runner');
  return { pins: { job: job.pin, status: status.pin, log: { filename: config.validationLog, ...identity(logBytes) } },
    summary: { tests: 77, passed: 77, failed: 0, cancelled: 0, skipped: 0, todo: 0,
      sourceTests: 36, diagnosticPolicyTests: 41, sourceRejectionCases: 27, frozenInputFilesReopened: job.value.inputs.length,
      sourceCodeAndBaselineInputsUnchanged: true, sourceGuardReceiptBoundToRawLog: true,
      recordFormat: 'raw-node-spec', completeCommandAndLogBoundToFrozenJob: true } };
}

async function sourceAndDiagnosticGuards(config, sourceLock) {
  const core = await load(config.coreGuards), guards = core.value;
  assert.equal(guards.schemaVersion, 1); assert.equal(guards.kind, 'common-deque-api-source-guards');
  assert.equal(guards.sourceLockSha256, sourceLock.pin.sha256);
  assert.equal(guards.baselineSelectionSha256, sourceLock.value.selection.sha256);
  assert.equal(guards.baselineFixture, config.baselineSelection);
  assert.equal(guards.actualSelectedSources, 3571); assert.equal(guards.jvmSignatureSources, 18);
  assert.equal(guards.replacedSources, 6); assert.equal(guards.addedSources, 0); assert.equal(guards.excludedSources, 0);
  for (const field of ['baselineFilesUnmodified', 'mutationSourcesRestored', 'allSelectedBytesReopened', 'completeSixSourceInverse'])
    assert.equal(guards[field], true, 'Source guard claim changed: ' + field);
  for (const field of ['predecessorProductionGuardsExecuted', 'compilerExecuted', 'fullCompilerBuilt', 'publicLanguageSupport'])
    assert.equal(guards[field], false, 'Source guard scope must not claim compiler execution');
  assert.equal(guards.cases.length, 27); assert.equal(new Set(guards.cases.map(row => row.name)).size, 27);
  assert(guards.cases.every(row => typeof row.name === 'string' && row.name && row.rejected === true));
  const diagnostics = await load(config.diagnosticGuards), checks = diagnostics.value;
  assert.equal(checks.kind, 'common-deque-diagnostic-policy-unit-checks');
  assert.equal(checks.exitCode, 0); assert.equal(checks.tests, 41); assert.equal(checks.passed, 41);
  assert.equal(checks.failed, 0); assert.equal(checks.skipped, 0); assert.equal(checks.cwd, repository);
  assert.deepEqual(checks.command, ['node', '--test', 'producer/kotlin-browser/compiler-port/common-deque-api/diagnostics.test.mjs']);
  const expectedFiles = ['diagnostics.mjs', 'diagnostics.test.mjs', 'transform.mjs'].map(name => path.join(here, name));
  assert.deepEqual(checks.filesAtCompletion.map(row => row.filename), expectedFiles);
  assert.equal(checks.actualPredecessorReopen.exitCode, 0); assert.equal(checks.actualPredecessorReopen.sources, 3571);
  assert.equal(checks.actualPredecessorReopen.diagnostics, 1250); assert.equal(checks.actualPredecessorReopen.immutableArtifactPins, 6);
  const validation = await verifyDequeValidation(config);
  return { pins: { core: core.pin, historicalDiagnostics: diagnostics.pin, validation: validation.pins },
    summary: { ...validation.summary,
      sourceGuardScope: 'Full-source selection/inverse and rejection checks, bound to current test code, completed frozen execution and original Node spec output. Production predecessor guards are separately reopened by this verifier.',
      historicalDiagnosticRecordScope: 'Earlier manual 41-test tool observation retained as history only. The completed frozen 77-test run and raw log provide the current validation evidence.' } };
}

/** Single verification path shared by fresh sealing and read-only replay. */
export async function inspectCompletedDequeEvidence(configuration) {
  const config = normalizeDequeEvidenceConfiguration(configuration);
  const shipping = await shippingPins();
  const sourceLock = await load(path.join(here, 'sources.lock.json'));
  const status = await load(config.status), job = await load(config.job);
  assert.equal(status.value.state, 'exited'); assert.equal(status.value.exitCode, 1);
  assert.equal(status.value.frozenInputsUnchanged, true); assert.deepEqual(status.value.changedInputs, []);
  assert.equal(status.value.sourceRoot, config.snapshotRoot); assert.equal(status.value.log, config.log);
  assert(Number.isFinite(status.value.startedUnix) && Number.isFinite(status.value.finishedUnix) &&
    status.value.finishedUnix >= status.value.startedUnix, 'Completed whole-build timestamps required');
  assert.equal(status.value.configSha256, job.pin.sha256, 'Whole status is not bound to the recorded launch job');
  assert.equal(job.value.kind, 'official-common-deque-whole-build-job'); assert.equal(job.value.cwd, config.snapshotRoot);
  assert.equal(job.value.status, config.status); assert.equal(job.value.log, config.log);
  assert.deepEqual(status.value.argv, job.value.argv);
  assert.equal(job.value.argv[0], 'node'); assert.equal(job.value.argv[1], path.join(config.snapshotRoot, 'producer/kotlin-browser/compiler-port/build.mjs'));
  assert.equal(job.value.argv.filter(value => value === '--output').length, 1);
  assert.equal(job.value.argv[job.value.argv.indexOf('--output') + 1], config.buildRoot);
  assert(Array.isArray(job.value.inputs) && job.value.inputs.length > 10000);
  assert.equal(status.value.inputCount, job.value.inputs.length);
  assert.equal(new Set(job.value.inputs.map(row => row.filename)).size, job.value.inputs.length);
  for (let offset = 0; offset < job.value.inputs.length; offset += 16) {
    const batch = await Promise.allSettled(job.value.inputs.slice(offset, offset + 16).map(verifyDequePinnedFile));
    for (const result of batch) if (result.status !== 'fulfilled') throw result.reason;
  }
  // Authenticate copied code against the review checkout before any verifier
  // dynamically imports modules owned by a separate build snapshot.
  const snapshot = await bindReviewableSnapshot(config, job.value, shipping);
  const build = { snapshotRoot: config.snapshotRoot, buildRoot: config.buildRoot, status: status.pin,
    receipt: await pinFile(path.join(config.buildRoot, 'compiler-build-receipt.json')), log: await pinFile(config.log) };
  const current = await reopenPsiBuild(build);
  assert(current.dequeOptions && current.dequeFinal, 'Actual six-source deque composition required');
  assert.equal(current.actual.length, 3571);
  assert.deepEqual(current.receipt.commonDequeApiReceipt.replacedOriginalPaths, TARGETS);
  assert.deepEqual(current.receipt.commonDequeApiReceipt.sourceSetExclusions, []);
  assert.deepEqual(current.receipt.commonDequeApiReceipt.addedSources, []);
  const builderPin = job.value.inputs.find(pin => pin.filename === job.value.argv[1]); assert(builderPin);
  assert.equal(builderPin.sha256, current.receipt.buildToolSha256);
  const reviewedBuilder = shipping.find(pin => pin.filename === path.join(repository, 'producer/kotlin-browser/compiler-port/build.mjs'));
  assert(reviewedBuilder);
  assert.deepEqual({ bytes: builderPin.bytes, sha256: builderPin.sha256 },
    { bytes: reviewedBuilder.bytes, sha256: reviewedBuilder.sha256 });
  await reopenPsiNativeModuleContracts(current);
  const diagnostics = await compareDequeDiagnostics({ currentBuild: config.buildRoot, currentLog: config.log,
    baselineSelection: config.baselineSelection, baselineLog: config.baselineLog });
  assert.equal(diagnostics.result, 'pass'); assert.equal(diagnostics.actualSourceFilesReopened, 7142);
  assert.equal(diagnostics.compilerLibraryPinsReopened, 13);
  const checks = await sourceAndDiagnosticGuards(config, sourceLock);
  const runtimePin = await pinFile(config.runtimeReceipt);
  const runtimeApi = await import('./runtime-probe.mjs');
  const runtime = await runtimeApi.verifyDequeRuntime(config.runtimeReceipt);
  assert.equal(runtime.result, 'pass'); assert.equal(runtime.sources, 10);
  assert(Number.isSafeInteger(runtime.nodeCases) && runtime.nodeCases > 0);
  assert.equal(runtime.nodeCases, runtime.chromiumCases);
  const runtimeValue = JSON.parse(await readRegular(config.runtimeReceipt, 32 * 1024 * 1024));
  assert.deepEqual(runtimeValue.source, sourceLock.value.source);
  assert.equal(runtimeValue.comparison.completeChangedFiles, 6);
  assert.equal(runtimeValue.comparison.completeUnchangedInlineCallers, 4);
  assert.equal(runtimeValue.comparison.sourceAndBinaryPhasesUseAuthenticatedOverlays, true);
  for (const pin of shipping) await verifyDequePinnedFile(pin);
  for (const pin of [status.pin, job.pin, sourceLock.pin, runtimePin, checks.pins.core, checks.pins.historicalDiagnostics,
    ...Object.values(checks.pins.validation), ...snapshot.pins]) await verifyDequePinnedFile(pin);
  const diagnosticsBytes = jsonBytes(diagnostics);
  const evidence = { schemaVersion: 1, kind: 'common-deque-api-current-foundation-v1', result: 'pass',
    configuration: config, reviewRoot: repository, sourceSnapshot: snapshot.summary, sourceLock: sourceLock.pin, build,
    wholeJob: job.pin, baselineSelection: await pinFile(config.baselineSelection), baselineLog: await pinFile(config.baselineLog),
    runtimeReceipt: runtimePin, checks: checks.pins, shippingInputs: shipping,
    diagnostics: { filename: config.diagnosticsFile, ...identity(diagnosticsBytes) },
    compiler: { orderedSources: 3571, changedWholeSources: 6, unchangedSources: 3565, addedSources: 0, excludedSources: 0,
      retainedJvmSignatureSources: 18, compilerAndLibraryFiles: 13, frozenInputsReopened: job.value.inputs.length,
      compilerExitCode: 1, completeSixFileInverseEqualsAuthenticatedBaseline: true,
      actualPositionalAndCommonVectorsVerified: true, compilerLibrariesOptionsHeapAndDeadlineUnchanged: true,
      actualGraphAndNativeModuleContractsReopened: true },
    diagnosticComparison: { baseline: 1250, current: 1221, removed: 29, remainingTargetDiagnostics: 4,
      added: 0, survivingPositionMessageAndMultiplicityExact: true, diagnosticWaivers: [] },
    runtime, regressionChecks: checks.summary,
    validationScope: 'Six complete official compiler files adapt deque API calls. All other source bytes, traversal order and full compiler selections remain authenticated. Full-source compiler still exits 1; genuine original/common JVM overlays compile user programs whose Wasm runs in Node and offline Chromium.',
    runtimeLimits: runtimeValue.limits,
    fullCompilerBuilt: false, browserKotlinCompilation: false, wholeFirResolutionExecuted: false,
    userSourceRewritten: false, publicLanguageSupport: false };
  return { evidence, diagnostics, diagnosticsBytes };
}

export async function verifyDequeEvidence(evidence) {
  assert.equal(evidence?.schemaVersion, 1); assert.equal(evidence.kind, 'common-deque-api-current-foundation-v1');
  assert.equal(evidence.result, 'pass');
  for (const field of ['fullCompilerBuilt', 'browserKotlinCompilation', 'wholeFirResolutionExecuted', 'userSourceRewritten', 'publicLanguageSupport'])
    assert.equal(evidence[field], false);
  for (const pin of evidence.shippingInputs) await verifyDequePinnedFile(pin);
  const reopened = await inspectCompletedDequeEvidence(evidence.configuration);
  assert.deepEqual(evidence, reopened.evidence, 'Recorded foundation evidence differs from fresh verification');
  const report = await readRegular(evidence.diagnostics.filename, 16 * 1024 * 1024);
  assert.deepEqual(identity(report), { bytes: evidence.diagnostics.bytes, sha256: evidence.diagnostics.sha256 });
  assert.deepEqual(report, reopened.diagnosticsBytes, 'Recorded diagnostic report differs from complete comparison');
  return { result: 'pass', compiler: evidence.compiler, diagnosticComparison: evidence.diagnosticComparison,
    runtime: evidence.runtime, regressionChecks: evidence.regressionChecks,
    fullCompilerBuilt: false, browserKotlinCompilation: false, publicLanguageSupport: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const filename = path.resolve(process.argv[2] ?? path.join(here, 'evidence/current-foundation-v1.json'));
  const evidence = JSON.parse(await readRegular(filename));
  console.log(JSON.stringify(await verifyDequeEvidence(evidence)));
}
