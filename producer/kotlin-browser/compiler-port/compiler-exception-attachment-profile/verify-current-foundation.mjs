import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRegular, relativePath, sha256 } from '../../scripts/source.mjs';
import { checked, reopenBuildSelection } from './verify.mjs';
import { compareDiagnostics } from './diagnostics.mjs';
import { compilerInputPins, projectControlArguments, verifySourceRows } from './current-foundation-control.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });

async function verifyHistoricalFailure(history) {
  const baseline = JSON.parse(await checked(history.baselineEvidence));
  assert.equal(baseline.kind, 'compiler-exception-attachment-baseline-evidence-v3');
  assert.equal(baseline.currentFoundationQualified, false);
  const failure = baseline.build.currentFoundationFailure;
  const state = JSON.parse(await checked(failure.status));
  const receipt = JSON.parse(await checked(failure.receipt));
  assert.equal(state.state, 'exited'); assert.equal(state.exitCode, 1);
  assert.equal(state.sourceRoot, failure.snapshotRoot);
  assert.equal(receipt.status, 'failed'); assert.deepEqual(receipt.commands, []);
  assert.equal(receipt.compileSources, undefined);
  assert.equal(receipt.compilerExceptionAttachmentReceipt, undefined);
  assert.equal(receipt.jvmDescriptorSignatureImplementationsReceipt.files.length, 18);
  assert.equal(receipt.failure, 'Excluded facade island consumer outside original storage: ' +
    'compiler-port-jvm-descriptor-signatures/SignatureBuildingComponents.kt');
  assert((await checked(failure.log)).toString().includes(receipt.failure));
  assert.equal(history.firGuard.filename, path.join(failure.snapshotRoot,
    'producer/kotlin-browser/compiler-port/fir-storage-source-profile/prepare.mjs'));
  await checked(history.firGuard);
  assert.notEqual(history.firGuard.sha256, sha256(await readRegular(path.join(here, '../fir-storage-source-profile/prepare.mjs'))));
  for (const row of baseline.archivedSnapshots) {
    const descriptor = JSON.parse(await checked(row.descriptor));
    assert.equal(descriptor.sourceRoot, row.sourceRoot);
    assert.equal(descriptor.sha256, row.archive.sha256);
    await checked(row.archive, 512 * 1024 * 1024);
  }
  return baseline;
}

async function verifyRuntime(evidence) {
  const runtime = JSON.parse(await checked(evidence.runtime));
  assert.equal(runtime.status, 'passed'); assert.equal(runtime.inputsUnchanged, true);
  assert.equal(runtime.sourceLock.sha256, evidence.sourceLock.sha256);
  for (const pin of runtime.inputs) await checked(pin);
  for (const row of runtime.results) {
    const report = JSON.parse(await checked(row));
    assert.equal(report.result, 'pass');
    assert(report.commands.every(command => command.exitCode === 0));
    for (const pin of [...report.inputs, ...report.artifacts, ...report.bootstrap]) await checked(pin);
    if (report.comparison) {
      assert.equal(report.comparison.originalJvmSha256, report.comparison.commonJvmSha256);
      assert.equal(report.comparison.originalJvmSha256, report.comparison.nodeWasmSha256);
    }
    if (row.family === 'platform-policy') {
      assert.equal(report.requestScopedHostExecuted, true); assert.equal(report.hostRecords, 8);
      assert.equal(report.hostJvmSha256, report.hostWasmSha256);
    }
  }
  const browser = JSON.parse(await checked(evidence.browser));
  assert.equal(browser.status, 'passed'); assert.equal(browser.engine, 'chromium');
  assert.equal(browser.cases.length, 3);
  for (const row of browser.cases) assert.deepEqual(row.actual, row.expected);
  for (const pin of browser.inputs) await checked(pin);
}

export async function reopenNativeModuleContracts(build, description) {
  const port = path.join(description.snapshotRoot, 'producer/kotlin-browser/compiler-port');
  const sourceRoot = build.options.sourceRoot;
  async function component(key, receiptName) {
    const outputRoot = path.join(description.buildRoot, 'components', key), receiptPath = path.join(outputRoot, receiptName);
    const bytes = await readRegular(receiptPath, 64 * 1024 * 1024), receipt = JSON.parse(bytes);
    assert.deepEqual(receipt, build.receipt[key]);
    return { outputRoot, receiptPath, receipt, receiptSha256: sha256(bytes),
      commonSources: (receipt.files ?? []).map(row => path.join(outputRoot, row.path)) };
  }
  const serializer = await component('serializerOutputReceipt', 'serializer-output-inputs.json');
  const comments = await component('serializerCommentTypeNamesReceipt', 'serializer-comment-type-names-inputs.json');
  const modules = await import(pathToFileURL(path.join(port, 'module-relative-paths/prepare.mjs')));
  const moduleFinal = await modules.reconstructModuleRequirePathPredecessorSelection({ sourceRoot,
    outputRoot: path.join(description.buildRoot, 'components/moduleRequirePathsReceipt'),
    preparedCommentTypeNames: comments,
    commentTypeNameOptions: { sourceRoot, outputRoot: comments.outputRoot, preparedSerializerOutput: serializer,
      serializerOutputOptions: { sourceRoot, outputRoot: serializer.outputRoot } },
    retainedSources: build.actual });
  assert.deepEqual(moduleFinal, build.receipt.moduleRequirePathsFinalReceipt);
  assert.deepEqual(moduleFinal.final.inputs, build.actual.map(({ path, filename, bytes, sha256 }) => ({ path, filename, bytes, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path)));
  const native = await import(pathToFileURL(path.join(port, 'native-js-output-profile/prepare.mjs')));
  const inputs = await native.inspectNativeJsOutputInputs(sourceRoot);
  const selected = await native.inspectNativeJsOutputSelection(inputs, build.actual, { excludeTarget: true });
  const recorded = build.receipt.nativeJsOutputProfileFinalReceipt;
  for (const field of ['inspectedFiles', 'inspectedBytes', 'inventorySha256', 'incoming', 'existingProfileClosure'])
    assert.deepEqual(selected[field], recorded[field]);
  assert.deepEqual(selected.splitBoundaries.map(({ source, ...pin }) => pin), recorded.existingSplitBindings);
  assert.deepEqual(selected.boundaries.map(({ originalPath, path, filename, bytes, sha256 }) => ({ originalPath, path, filename, bytes, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path)),
  recorded.retainedBoundaryBindings.map(({ originalPath, path, filename, bytes, sha256 }) => ({ originalPath, path, filename, bytes, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path)));
  const phases = await component('loweringPhaseFactoriesReceipt', 'receipt.json');
  const nativeFirst = await component('nativeFirstPhaseSourceProfileReceipt', 'receipt.json');
  const phase = await import(pathToFileURL(path.join(port, 'native-js-output-profile/phase-boundary.mjs')));
  const reopened = await phase.bindNativeLoweringPhaseBoundary({ sourceRoot,
    boundary: { sourceRoot, outputRoot: phases.outputRoot, expectedReceiptSha256: phases.receiptSha256,
      nativeFirstPhaseProfile: { sourceRoot, outputRoot: nativeFirst.outputRoot, expectedReceiptSha256: nativeFirst.receiptSha256 },
      compilerExceptionProfile: build.options },
    retainedSources: build.actual, recordedPropertyImports: build.receipt.propertyImports.imports,
    requiredBoundaries: inputs.lock.requiredBoundaries, source: inputs.lock.source });
  assert.deepEqual(reopened.receipt, recorded.loweringPhaseFactoryBinding);
}

export async function reopenCurrentFoundation(evidence) {
  const build = await reopenBuildSelection(evidence.build);
  assert.equal(build.variant, undefined); assert.equal(build.actual.length, 3571);
  assert.equal(build.receipt.jvmDescriptorSignatureImplementationsReceipt.files.length, 18);
  assert.equal(build.reopened.predecessorRetainedSources.length, 3571);
  const jvmRows = build.actual.filter(row => row.path.startsWith('compiler-port-jvm-descriptor-signatures/'));
  assert.equal(jvmRows.length, 18);
  assert.deepEqual(jvmRows, build.reopened.predecessorRetainedSources.filter(row => row.path.startsWith('compiler-port-jvm-descriptor-signatures/')));
  assert.deepEqual(identity(build.receiptBytes), { bytes: evidence.build.receipt.bytes, sha256: evidence.build.receipt.sha256 });
  await checked(evidence.build.log);
  const state = JSON.parse(await checked(evidence.build.status));
  assert.equal(state.state, 'exited'); assert.equal(state.frozenInputsUnchanged, true);
  assert.equal(state.exitCode, 1); assert.equal(build.command.exitCode, 1);
  assert.deepEqual(state.changedInputs, []);
  assert.equal(state.argv[state.argv.indexOf('--output') + 1], evidence.build.buildRoot);
  assert.equal(state.argv[1], path.join(evidence.build.snapshotRoot, 'producer/kotlin-browser/compiler-port/build.mjs'));
  const inventory = JSON.parse(await checked(evidence.frozenInputs));
  assert.equal(inventory.sourceRoot, evidence.build.snapshotRoot);
  const seen = new Set();
  for (const row of inventory.records) {
    relativePath(row.path); assert(!seen.has(row.path)); seen.add(row.path);
    const bytes = await readRegular(path.join(inventory.sourceRoot, row.path), 128 * 1024 * 1024);
    assert.deepEqual(identity(bytes), { bytes: row.bytes, sha256: row.sha256 }, 'Frozen build input changed: ' + row.path);
  }
  const outputs = JSON.parse(await checked(evidence.outputInventory));
  assert.equal(outputs.sourceRoot, evidence.build.snapshotRoot);
  assert.deepEqual(outputs.buildDirectories, [evidence.build.buildRoot, evidence.control.buildRoot]
    .map(root => path.relative(evidence.build.snapshotRoot, root)));
  const outputPaths = new Set();
  for (const row of outputs.records) {
    relativePath(row.path); assert(!outputPaths.has(row.path)); outputPaths.add(row.path);
    assert(outputs.buildDirectories.some(prefix => row.path.startsWith(prefix + '/')));
    const bytes = await readRegular(path.join(outputs.sourceRoot, row.path), 128 * 1024 * 1024);
    assert.deepEqual(identity(bytes), { bytes: row.bytes, sha256: row.sha256 }, 'Current validation output changed: ' + row.path);
  }
  for (const relative of ['prepare.mjs', 'sources.lock.json', 'transform.mjs']) {
    const filename = path.join(here, '../fir-storage-source-profile', relative);
    assert.deepEqual(await readRegular(filename), await readRegular(path.join(evidence.build.snapshotRoot,
      path.relative(repository, filename))), 'Current FIR guard differs from the actual compiler preparation');
  }
  const fir = await import(pathToFileURL(path.join(evidence.build.snapshotRoot,
    'producer/kotlin-browser/compiler-port/fir-storage-source-profile/prepare.mjs')));
  const final = await fir.verifyFinalFirStorageSourceProfile({
    profileRoot: path.join(evidence.build.buildRoot, 'components/firStorageSourceProfileReceipt'),
    retainedSources: build.reopened.predecessorRetainedSources,
    allowedAddedImports: ['kotlin.jvm.*', ...build.receipt.propertyImports.imports,
      'org.jetbrains.kotlin.portable.assertions.compilerAssert as assert'],
  });
  assert.deepEqual(final, build.receipt.firStorageSourceProfileFinalReceipt);
  assert.equal(final.guard.portableJvmClassNameSources.length, 6);
  assert.deepEqual(final.guard.facadeIslandConsumers, []);
  assert.equal(final.guard.allowNonCachedDeclarations, false);
  assert.equal(final.guard.lightTreeSourceHostOnly, true);
  const jvmRoot = path.join(evidence.build.buildRoot, 'components/jvmDescriptorSignatureImplementationsReceipt');
  const jvm = await import(pathToFileURL(path.join(evidence.build.snapshotRoot,
    'producer/kotlin-browser/compiler-port/jvm-descriptor-signature-implementations/prepare.mjs')));
  const signatures = await jvm.verifyFinalJvmDescriptorSignatureImplementations({ outputRoot: jvmRoot,
    expectedReceiptSha256: sha256(await readRegular(path.join(jvmRoot, 'receipt.json'), 64 * 1024 * 1024)),
    retainedSources: build.reopened.predecessorRetainedSources, recordedPropertyImports: build.receipt.propertyImports.imports });
  assert.deepEqual(signatures.receipt, build.receipt.jvmDescriptorSignatureImplementationsFinalReceipt);
  await reopenNativeModuleContracts(build, evidence.build);
  return build;
}

export async function verifyCurrentFoundationControl(control, build, buildDescription) {
  const status = JSON.parse(await checked(control.status));
  assert.equal(status.state, 'exited'); assert.equal(status.exitCode, 0);
  assert.equal(status.toolInputsUnchanged, true);
  for (const pin of status.toolInputs) await checked(pin);
  assert.equal(status.argv[1], path.join(here, 'current-foundation-control.mjs'));
  assert.equal(status.sourceRoot, buildDescription.snapshotRoot);
  assert(status.startedUnix >= JSON.parse(await checked(buildDescription.status)).finishedUnix,
    'The control must start after the current compiler has exited');
  assert(control.buildRoot.startsWith(path.join(buildDescription.snapshotRoot, 'out') + path.sep));
  assert.equal(control.receipt.filename, path.join(control.buildRoot, 'compiler-build-receipt.json'));
  assert.equal(control.selection.filename, path.join(control.buildRoot, 'control-selection.json'));
  const receipt = JSON.parse(await checked(control.receipt));
  const selectionBytes = await checked(control.selection), selection = JSON.parse(selectionBytes);
  assert.equal(receipt.kind, 'compiler-exception-authenticated-predecessor-control');
  assert.equal(selection.kind, 'authenticated-exception-predecessor-control-selection');
  assert.equal(receipt.currentBuildReceiptSha256, sha256(build.receiptBytes));
  assert.equal(selection.currentBuildReceiptSha256, sha256(build.receiptBytes));
  assert.equal(receipt.selectionSha256, sha256(selectionBytes));
  assert.equal(receipt.inputsUnchanged, true);
  assert.deepEqual(selection.current, build.actual);
  assert.deepEqual(selection.predecessor, build.reopened.predecessorRetainedSources);
  assert.deepEqual(selection.exceptionFinalReceipt, build.reopened.receipt);
  assert.deepEqual(receipt.compileSources, selection.predecessor.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })));
  const currentArgs = (await readRegular(path.join(buildDescription.buildRoot, 'compiler-klib.args'), 16 * 1024 * 1024))
    .toString().trimEnd().split('\n').map(JSON.parse);
  const expectedArgs = projectControlArguments(currentArgs, build.actual, selection.predecessor, control.buildRoot);
  const argumentFile = path.join(control.buildRoot, 'compiler-klib.args'), argumentBytes = await readRegular(argumentFile, 16 * 1024 * 1024);
  assert.deepEqual(argumentBytes.toString().trimEnd().split('\n').map(JSON.parse), expectedArgs);
  assert.equal(receipt.commands.length, 1);
  const command = receipt.commands[0];
  assert.equal(command.phase, 'official-compiler-source-to-wasmjs-klib');
  assert.deepEqual(command.command, [...build.command.command.slice(0, -1), '@' + argumentFile]);
  assert.equal(command.argumentFileSha256, sha256(argumentBytes));
  assert.equal(command.maximumHeap, build.command.maximumHeap); assert.equal(command.timeoutMs, build.command.timeoutMs);
  assert.equal(command.signal, null); assert.equal(command.exitCode, 1);
  assert(command.elapsedMs > 0 && Number.isSafeInteger(command.pid));
  assert.deepEqual(receipt.bootstrap, build.receipt.bootstrap);
  assert.deepEqual(receipt.hostLibraries, build.receipt.hostLibraries);
  assert.deepEqual(await compilerInputPins(command.command, expectedArgs, receipt.bootstrap, receipt.hostLibraries), selection.compilerInputs);
  await verifySourceRows(selection.predecessor);
  await checked(control.log);
  return command;
}

export async function verifyCurrentFoundationEvidence(filename = path.join(here, 'evidence/current-foundation-v4.json')) {
  const evidence = JSON.parse(await readRegular(filename));
  assert.equal(evidence.kind, 'compiler-exception-current-foundation-evidence-v4');
  assert.equal(evidence.result, 'pass'); assert.equal(evidence.currentFoundationQualified, true);
  assert.equal(evidence.build.baselineVariant, undefined); assert.equal(evidence.build.currentFoundationFailure, undefined);
  for (const pin of evidence.shippingInputs) await checked(pin);
  assert.deepEqual(await checked(evidence.sourceLock), await readRegular(path.join(here, 'sources.lock.json')));
  const historical = await verifyHistoricalFailure(evidence.history);
  assert.deepEqual(evidence.runtime, historical.runtime); assert.deepEqual(evidence.browser, historical.browser);
  const build = await reopenCurrentFoundation(evidence);
  const control = await verifyCurrentFoundationControl(evidence.control, build, evidence.build);
  const diagnostics = JSON.parse(await checked(evidence.diagnostics));
  assert.equal(diagnostics.currentBuild, evidence.build.buildRoot); assert.equal(diagnostics.currentLog, evidence.build.log.filename);
  assert.equal(diagnostics.baselineBuild, evidence.control.buildRoot); assert.equal(diagnostics.baselineLog, evidence.control.log.filename);
  assert.deepEqual(await compareDiagnostics(diagnostics.currentBuild, diagnostics.currentLog,
    diagnostics.baselineBuild, diagnostics.baselineLog), diagnostics);
  assert(diagnostics.baselineTotal > 0 && diagnostics.currentTotal > 0);
  assert(diagnostics.baselineProfileEntries.length > diagnostics.currentProfileEntries.length);
  assert.deepEqual(diagnostics.newProfileDiagnosticEntries, []);
  assert.deepEqual(diagnostics.newOtherDiagnosticEntries, []);
  const guards = JSON.parse(await checked(evidence.guards));
  assert.equal(guards.actualSources, 3571); assert(guards.cases.length >= 7);
  assert(guards.cases.every(row => row.rejected && row.reasonMatched)); assert.equal(guards.restoredSourceState, true);
  const guardState = JSON.parse(await checked(evidence.guardsExecution.status));
  assert.equal(guardState.state, 'exited'); assert.equal(guardState.exitCode, 0);
  assert.equal(guardState.toolInputsUnchanged, true);
  assert.equal(guardState.sourceRoot, evidence.build.snapshotRoot);
  assert.equal(guardState.argv[1], path.join(here, 'qualify-source.mjs'));
  assert(guardState.startedUnix >= JSON.parse(await checked(evidence.control.status)).finishedUnix,
    'Source mutations must start after both compiler invocations have exited');
  for (const pin of guardState.toolInputs) await checked(pin);
  await checked(evidence.guardsExecution.log);
  await verifyRuntime(evidence);
  assert.equal(evidence.fullCompilerBuilt, false); assert.equal(evidence.browserCompilerExecuted, false);
  return { result: 'pass', sourceFiles: 3571, currentJvmSignatureSources: 18,
    portableJvmClassNameBindings: 6, wholeCompilerExitCode: build.command.exitCode,
    controlCompilerExitCode: control.exitCode, baselineDiagnostics: diagnostics.baselineTotal,
    currentDiagnostics: diagnostics.currentTotal, newProfileDiagnostics: 0, newOtherDiagnostics: 0,
    sourceGuards: guards.cases.length, chromiumWorkers: 3, currentFoundationQualified: true,
    fullCompilerBuilt: false, browserCompilerExecuted: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await verifyCurrentFoundationEvidence(process.argv[2])));
