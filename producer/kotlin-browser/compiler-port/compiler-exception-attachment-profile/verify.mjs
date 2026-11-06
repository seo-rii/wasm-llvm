import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRegular, sha256, assertNoSymlink } from '../../scripts/source.mjs';
import { compareDiagnostics } from './diagnostics.mjs';
import { authenticateBaselineVariant, BASELINE_BUILD_SHA256 } from './baseline-variant.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
export async function checked(pin, maximum = 96 * 1024 * 1024) {
  const filename = pin.filename ?? pin.path;
  await assertNoSymlink(filename);
  const bytes = await readRegular(filename, maximum);
  assert.deepEqual(identity(bytes), { bytes: pin.bytes, sha256: pin.sha256 }, 'Evidence changed: ' + filename);
  return bytes;
}
export async function verifyCurrentFoundationFailure(failure) {
  const state = JSON.parse(await checked(failure.status));
  assert.equal(state.state, 'exited');
  assert.equal(state.exitCode, 1);
  assert.equal(state.sourceRoot, failure.snapshotRoot);
  assert(failure.buildRoot.startsWith(path.join(failure.snapshotRoot, 'out') + path.sep));
  assert.equal(failure.receipt.filename, path.join(failure.buildRoot, 'compiler-build-receipt.json'));
  const receiptBytes = await checked(failure.receipt), receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.kind, 'official-kotlin-compiler-wasmjs-build');
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.publicLanguageSupport, false);
  assert.deepEqual(receipt.commands, []);
  assert.equal(receipt.compileSources, undefined);
  assert.equal(receipt.compilerExceptionAttachmentReceipt, undefined);
  assert.equal(receipt.jvmDescriptorSignatureImplementationsReceipt.files.length, 18);
  assert.equal(receipt.failure, 'Excluded facade island consumer outside original storage: ' +
    'compiler-port-jvm-descriptor-signatures/SignatureBuildingComponents.kt');
  assert((await checked(failure.log)).toString().includes(receipt.failure));
  const shipping = await readRegular(path.join(here, '../build.mjs'));
  assert.equal(receipt.buildToolSha256, sha256(shipping));
  assert.deepEqual(await readRegular(path.join(failure.snapshotRoot,
    'producer/kotlin-browser/compiler-port/build.mjs')), shipping);
  assert.deepEqual(await readRegular(path.join(failure.snapshotRoot,
    'producer/kotlin-browser/compiler-port/fir-storage-source-profile/prepare.mjs')),
  await readRegular(path.join(here, '../fir-storage-source-profile/prepare.mjs')));
  return { result: 'preparation-blocked', compilerInvoked: false, currentFoundationQualified: false,
    reason: receipt.failure };
}
export async function reopenBuildSelection({ buildRoot, snapshotRoot, status, baselineVariant, currentFoundationFailure }) {
  const state = JSON.parse(await checked(status));
  assert.equal(state.state, 'exited');
  assert(Number.isSafeInteger(state.exitCode));
  assert.equal(state.sourceRoot, snapshotRoot);
  assert.equal(path.resolve(buildRoot), buildRoot);
  assert(buildRoot.startsWith(path.join(snapshotRoot, 'out') + path.sep));
  const snapshotProfile = path.join(snapshotRoot, 'producer/kotlin-browser/compiler-port/compiler-exception-attachment-profile');
  const lockBytes = await readRegular(path.join(here, 'sources.lock.json'));
  const lock = JSON.parse(lockBytes);
  assert.deepEqual(await readRegular(path.join(snapshotProfile, 'sources.lock.json')), lockBytes);
  for (const pin of lock.dependencies) {
    const current = await readRegular(path.join(here, pin.path));
    assert.deepEqual(identity(current), { bytes: pin.bytes, sha256: pin.sha256 });
    assert.deepEqual(await readRegular(path.join(snapshotProfile, pin.path)), current);
  }
  for (const relative of ['native-js-output-profile/phase-boundary.mjs', 'native-js-output-profile/sources.lock.json']) {
    assert.deepEqual(await readRegular(path.join(snapshotProfile, '..', relative)), await readRegular(path.join(here, '..', relative)));
  }
  const snapshotBuild = await readRegular(path.join(snapshotProfile, '../build.mjs'));
  const shippingBuild = await readRegular(path.join(here, '../build.mjs'));
  let variant;
  if (baselineVariant) {
    assert(currentFoundationFailure, 'Baseline-only validation must retain the current foundation failure');
    const proof = JSON.parse(await checked(baselineVariant));
    const { baseline, foundation, ...recorded } = proof;
    variant = authenticateBaselineVariant({ baseline: (await checked(baseline)).toString(),
      foundation: (await checked(foundation)).toString(), shipping: shippingBuild.toString(), variant: snapshotBuild.toString() });
    assert.deepEqual(variant, recorded);
    await verifyCurrentFoundationFailure(currentFoundationFailure);
    assert.equal(state.variant, variant.kind);
  } else {
    assert.equal(currentFoundationFailure, undefined);
    assert.deepEqual(snapshotBuild, shippingBuild);
  }
  const receiptBytes = await readRegular(path.join(buildRoot, 'compiler-build-receipt.json'), 96 * 1024 * 1024);
  const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.kind, 'official-kotlin-compiler-wasmjs-build');
  assert.equal(receipt.publicLanguageSupport, false);
  assert.equal(receipt.buildToolSha256, sha256(snapshotBuild));
  if (variant) {
    assert.equal(receipt.jvmDescriptorSignatureImplementationsReceipt, undefined);
    assert.equal(receipt.compileSources.length, 3553);
  }
  const command = receipt.commands.find(row => row.phase === 'official-compiler-source-to-wasmjs-klib');
  assert(command, 'Source preparation alone does not establish a compiler invocation');
  assert.equal(command.signal, null);
  assert(Number.isSafeInteger(command.exitCode));
  const argumentBytes = await readRegular(path.join(buildRoot, 'compiler-klib.args'), 16 * 1024 * 1024);
  assert.equal(sha256(argumentBytes), command.argumentFileSha256);
  const args = argumentBytes.toString().trimEnd().split('\n').map(JSON.parse);
  const filenames = args.slice(-receipt.compileSources.length);
  const componentRoot = path.join(buildRoot, 'components/compilerExceptionAttachmentReceipt');
  const componentBytes = await readRegular(path.join(componentRoot, 'receipt.json'));
  const component = JSON.parse(componentBytes);
  assert.deepEqual(component, receipt.compilerExceptionAttachmentReceipt);
  const replacements = new Map(component.files.map(row => [row.before.path, row.after]));
  const actual = component.selection.sources.filter(row => !component.sourceSetExclusions.includes(row.path))
    .map(row => replacements.get(row.path) ?? structuredClone(row));
  actual.push(...component.helpers);
  assert.deepEqual(actual.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })), receipt.compileSources);
  assert.deepEqual(actual.map(row => row.filename), filenames);
  const api = await import(pathToFileURL(path.join(snapshotProfile, 'prepare.mjs')));
  const options = { sourceRoot: component.sourceRoot, outputRoot: componentRoot, retainedSources: actual,
    expectedReceiptSha256: sha256(componentBytes), recordedPropertyImports: receipt.propertyImports.imports };
  const reopened = await api.verifyCompilerExceptionAttachmentFinalSources(options);
  assert.deepEqual(reopened.receipt, receipt.compilerExceptionAttachmentFinalReceipt);
  assert.equal(reopened.receipt.exactRequestEntryHostBinding, true);
  assert.equal(reopened.receipt.completeEightRowPredecessorMetadataAndOrderPreserved, true);
  assert.equal(reopened.receipt.hostInstalledAtRequestEntry, true);
  assert.equal(receipt.nativeJsOutputProfileFinalReceipt.inspectedFiles, actual.length);
  assert.equal(receipt.nativeJsOutputProfileFinalReceipt.loweringPhaseFactoryBinding.actualCompilerGraphPreservedForLexicalAndModule, true);
  assert.deepEqual(receipt.nativeJsOutputProfileFinalReceipt.loweringPhaseFactoryBinding.compilerExceptionProfile, reopened.receipt);
  assert.equal(receipt.moduleRequirePathsFinalReceipt.actualFinalSources, actual.length);
  assert.equal(receipt.moduleRequirePathsFinalReceipt.canonicalReconstruction, true);
  return { receipt, receiptBytes, actual, command, api, options, reopened, variant };
}
export async function verifyCompilerExceptionAttachmentEvidence(evidenceFile = path.join(here, 'evidence/selection.json')) {
  const evidence = JSON.parse(await readRegular(evidenceFile));
  assert.equal(evidence.kind, 'compiler-exception-attachment-baseline-evidence-v3');
  assert.equal(evidence.result, 'pass');
  assert.equal(evidence.currentFoundationQualified, false);
  assert(evidence.build.baselineVariant && evidence.build.currentFoundationFailure);
  assert.deepEqual(evidence.archivedSnapshots.map(row => row.sourceRoot).sort(),
    [evidence.build.snapshotRoot, evidence.build.currentFoundationFailure.snapshotRoot].sort());
  for (const row of evidence.archivedSnapshots) {
    const descriptor = JSON.parse(await checked(row.descriptor));
    assert.equal(descriptor.sourceRoot, row.sourceRoot);
    assert.equal(descriptor.sha256, row.archive.sha256);
    assert.equal(descriptor.archiveIntegrityChecked, true);
    await checked(row.archive, 512 * 1024 * 1024);
  }
  for (const input of evidence.shippingInputs) await checked(input);
  assert.deepEqual(await checked(evidence.sourceLock), await readRegular(path.join(here, 'sources.lock.json')));
  const build = await reopenBuildSelection(evidence.build);
  const baseline = JSON.parse(await checked(evidence.baselineSelection));
  assert.equal(baseline.buildToolSha256, BASELINE_BUILD_SHA256);
  assert.deepEqual(build.reopened.predecessorRetainedSources.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    baseline.compileSources, 'The projected incoming selection must match the authentic baseline exactly');
  assert.deepEqual(identity(build.receiptBytes), { bytes: evidence.build.receipt.bytes, sha256: evidence.build.receipt.sha256 });
  await checked(evidence.build.log);
  const runtime = JSON.parse(await checked(evidence.runtime));
  assert.equal(runtime.status, 'passed');
  assert.equal(runtime.inputsUnchanged, true);
  assert.equal(runtime.sourceLock.sha256, evidence.sourceLock.sha256);
  for (const pin of runtime.inputs) await checked(pin);
  for (const row of runtime.results) {
    const report = JSON.parse(await checked(row));
    assert.equal(report.result, 'pass');
    assert(report.commands.every(command => command.exitCode === 0));
    for (const pin of [...report.inputs, ...report.artifacts]) await checked(pin);
    for (const pin of report.bootstrap) await checked(pin);
    if (report.comparison) {
      assert.equal(report.comparison.originalJvmSha256, report.comparison.commonJvmSha256);
      assert.equal(report.comparison.originalJvmSha256, report.comparison.nodeWasmSha256);
    }
    if (row.family === 'platform-policy') {
      assert.equal(report.requestScopedHostExecuted, true);
      assert.equal(report.hostRecords, 8);
      assert.equal(report.hostJvmSha256, report.hostWasmSha256);
    }
  }
  const browser = JSON.parse(await checked(evidence.browser));
  assert.equal(browser.status, 'passed');
  assert.equal(browser.engine, 'chromium');
  assert.equal(browser.cases.length, 3);
  for (const fixture of browser.cases) assert.deepEqual(fixture.actual, fixture.expected);
  for (const pin of browser.inputs) await checked(pin);
  const guards = JSON.parse(await checked(evidence.guards));
  assert(guards.cases.length >= 6);
  assert(guards.cases.every(row => row.rejected && row.reasonMatched));
  assert.equal(guards.restoredSourceState, true);
  const diagnostic = JSON.parse(await checked(evidence.diagnostics));
  assert.deepEqual(await compareDiagnostics(diagnostic.currentBuild, diagnostic.currentLog,
    diagnostic.baselineBuild, diagnostic.baselineLog), diagnostic);
  assert.equal(diagnostic.baselineTotal, 1422);
  assert.equal(diagnostic.baselineProfileEntries.length, 74);
  assert.equal(diagnostic.newProfileDiagnosticEntries.length, 0, 'New exception/entry diagnostics remain');
  assert.equal(diagnostic.newOtherDiagnosticEntries.length, 0, 'Unreviewed new diagnostics outside this profile remain');
  assert.equal(evidence.fullCompilerBuilt, false);
  assert.equal(evidence.browserCompilerExecuted, false);
  return { result: 'pass', sourceFiles: build.actual.length, upstreamAlgorithms: 5, requestEntry: 1,
    wholeCompilerExitCode: build.command.exitCode, runtimeStringRecords: 12, runtimeExceptionRecords: 57,
    genuineJvmPolicyRecords: 5, requestHostRecords: 8, chromiumWorkers: 3, guards: guards.cases.length,
    compilerValidation: build.variant.kind, currentFoundationQualified: false,
    fullCompilerBuilt: false, browserCompilerExecuted: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await verifyCompilerExceptionAttachmentEvidence(process.argv[2])));
