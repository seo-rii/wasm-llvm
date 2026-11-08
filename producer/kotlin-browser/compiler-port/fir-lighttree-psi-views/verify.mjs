import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRegular, relativePath, sha256 } from '../../scripts/source.mjs';
import { compilerInputPins, projectControlArguments } from '../compiler-exception-attachment-profile/current-foundation-control.mjs';
import { balancedSpan } from '../fir-navigation/transform.mjs';
import { actualPredecessor } from './fixture.mjs';
import { comparePsiDiagnostics } from './diagnostics.mjs';
import { TARGETS } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const logicalIdentity = rows => rows.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
export async function checked(pin, maximum = 128 * 1024 * 1024) {
  const bytes = await readRegular(pin.filename, maximum);
  assert.deepEqual(identity(bytes), { bytes: pin.bytes, sha256: pin.sha256 }, 'Evidence changed: ' + pin.filename);
  return bytes;
}

export async function reopenPsiBuild(description) {
  const port = path.join(description.snapshotRoot, 'producer/kotlin-browser/compiler-port');
  const state = JSON.parse(await checked(description.status));
  assert.equal(state.state, 'exited'); assert.equal(state.exitCode, 1);
  assert.equal(state.sourceRoot, description.snapshotRoot);
  assert.equal(state.frozenInputsUnchanged, true); assert.deepEqual(state.changedInputs, []);
  assert.equal(state.argv[1], path.join(port, 'build.mjs'));
  assert.equal(state.argv[state.argv.indexOf('--output') + 1], description.buildRoot);
  const bytes = await checked(description.receipt), receipt = JSON.parse(bytes);
  assert.equal(description.receipt.filename, path.join(description.buildRoot, 'compiler-build-receipt.json'));
  assert.equal(receipt.kind, 'official-kotlin-compiler-wasmjs-build'); assert.equal(receipt.status, 'failed');
  assert.equal(receipt.publicLanguageSupport, false); assert.equal(receipt.sourceHost, 'portable');
  assert.equal(receipt.buildToolSha256, sha256(await readRegular(path.join(port, 'build.mjs'))));
  assert.deepEqual(await readRegular(path.join(port, 'build.mjs')), await readRegular(path.join(here, '../build.mjs')));
  const command = receipt.commands.find(row => row.phase === 'official-compiler-source-to-wasmjs-klib');
  assert(command, 'A preparation-only failure cannot qualify this port');
  assert.equal(command.exitCode, 1); assert.equal(command.signal, null);
  const argumentFile = path.join(description.buildRoot, 'compiler-klib.args');
  const argumentBytes = await readRegular(argumentFile, 16 * 1024 * 1024);
  assert.equal(command.argumentFileSha256, sha256(argumentBytes));
  assert.equal(command.command.at(-1), '@' + argumentFile);
  const args = argumentBytes.toString().trimEnd().split('\n').map(JSON.parse);
  const outputRoot = path.join(description.buildRoot, 'components/firLightTreePsiViewsReceipt');
  const componentBytes = await readRegular(path.join(outputRoot, 'receipt.json'), 32 * 1024 * 1024);
  const component = JSON.parse(componentBytes);
  assert.deepEqual(component, receipt.firLightTreePsiViewsReceipt);
  assert.deepEqual(component.replacedOriginalPaths, TARGETS);
  assert.deepEqual(component.sourceSetExclusions, []); assert.deepEqual(component.addedSources, []);
  const replacements = new Map(component.files.map(row => [row.before.path, row.after]));
  let actual = component.selection.sources.map(row => structuredClone(replacements.get(row.path) ?? row));
  let towerOptions, towerFinal, mainEntryOptions, mainEntryFinal;
  if (receipt.firTowerModeMapReceipt) {
    const towerRoot = path.join(description.buildRoot, 'components/firTowerModeMapReceipt');
    const towerBytes = await readRegular(path.join(towerRoot, 'receipt.json'), 32 * 1024 * 1024);
    const tower = JSON.parse(towerBytes);
    assert.deepEqual(tower, receipt.firTowerModeMapReceipt);
    assert.deepEqual(tower.selection.sources, actual, 'Tower map must consume the complete PSI output');
    assert.equal(tower.files.length, 1); assert.deepEqual(tower.sourceSetExclusions, []);
    assert.deepEqual(tower.addedSources, []);
    const replacements = new Map(tower.files.map(row => [row.before.path, row.after]));
    actual = actual.map(row => structuredClone(replacements.get(row.path) ?? row));
    towerOptions = { sourceRoot: component.sourceRoot, outputRoot: towerRoot,
      expectedReceiptSha256: sha256(towerBytes), recordedPropertyImports: receipt.propertyImports.imports };
  }
  if (receipt.officialMainEntryReceipt) {
    assert(towerOptions, 'Official main entry requires the actual tower map output');
    const mainEntryRoot = path.join(description.buildRoot, 'components/officialMainEntryReceipt');
    const mainEntryBytes = await readRegular(path.join(mainEntryRoot, 'receipt.json'), 32 * 1024 * 1024);
    const mainEntry = JSON.parse(mainEntryBytes);
    assert.deepEqual(mainEntry, receipt.officialMainEntryReceipt);
    assert.deepEqual(mainEntry.selection.sources, actual, 'Official main entry must consume the complete tower output');
    assert.equal(mainEntry.files.length, 1); assert.deepEqual(mainEntry.sourceSetExclusions, []);
    assert.deepEqual(mainEntry.addedSources, []);
    const replacements = new Map(mainEntry.files.map(row => [row.before.path, row.after]));
    actual = actual.map(row => structuredClone(replacements.get(row.path) ?? row));
    mainEntryOptions = { sourceRoot: component.sourceRoot, outputRoot: mainEntryRoot,
      expectedReceiptSha256: sha256(mainEntryBytes), recordedPropertyImports: receipt.propertyImports.imports };
    const mainEntryApi = await import(pathToFileURL(path.join(port, 'official-main-entry/prepare.mjs')));
    mainEntryFinal = await mainEntryApi.verifyOfficialMainEntryFinalSources({ ...mainEntryOptions, retainedSources: actual });
    assert.deepEqual(mainEntryFinal.receipt, receipt.officialMainEntryFinalReceipt);
  }
  if (towerOptions) {
    const towerApi = await import(pathToFileURL(path.join(port, 'fir-tower-mode-map/prepare.mjs')));
    towerFinal = await towerApi.verifyFirTowerModeMapFinalSources({ ...towerOptions,
      retainedSources: mainEntryFinal?.predecessorRetainedSources ?? actual });
    assert.deepEqual(towerFinal.receipt, receipt.firTowerModeMapFinalReceipt);
  }
  assert.equal(actual.length, 3571); assert.deepEqual(logicalIdentity(actual), receipt.compileSources);
  assert.deepEqual(actual.map(row => row.filename), args.slice(-3571));
  assert.equal(args.filter(value => value.startsWith('-Xcommon-sources=')).length, 1);
  assert(args.includes('-Xcommon-sources=' + actual.map(row => row.filename).join(',')));
  const api = await import(pathToFileURL(path.join(port, 'fir-lighttree-psi-views/prepare.mjs')));
  const psiOptions = { sourceRoot: component.sourceRoot, outputRoot, expectedReceiptSha256: sha256(componentBytes),
    recordedPropertyImports: receipt.propertyImports.imports };
  const psiFinal = await api.verifyFirLightTreePsiViewFinalSources({ ...psiOptions,
    retainedSources: towerFinal?.predecessorRetainedSources ?? actual });
  assert.deepEqual(psiFinal.receipt, receipt.firLightTreePsiViewsFinalReceipt);
  const exceptionRoot = path.join(description.buildRoot, 'components/compilerExceptionAttachmentReceipt');
  const exceptionBytes = await readRegular(path.join(exceptionRoot, 'receipt.json'), 64 * 1024 * 1024);
  assert.deepEqual(JSON.parse(exceptionBytes), receipt.compilerExceptionAttachmentReceipt);
  const exceptionOptions = { sourceRoot: component.sourceRoot, outputRoot: exceptionRoot,
    expectedReceiptSha256: sha256(exceptionBytes), recordedPropertyImports: receipt.propertyImports.imports };
  assert.equal(component.previousException.outputRoot, exceptionRoot);
  assert.equal(component.previousException.expectedReceiptSha256, exceptionOptions.expectedReceiptSha256);
  const exceptionApi = await import(pathToFileURL(path.join(port, 'compiler-exception-attachment-profile/prepare.mjs')));
  const exceptionFinal = await exceptionApi.verifyCompilerExceptionAttachmentFinalSources({ ...exceptionOptions,
    retainedSources: psiFinal.predecessorRetainedSources });
  assert.deepEqual(exceptionFinal.receipt, receipt.compilerExceptionAttachmentFinalReceipt);
  const jvmRows = actual.filter(row => row.path.startsWith('compiler-port-jvm-descriptor-signatures/'));
  assert.equal(jvmRows.length, 18); assert.equal(receipt.jvmDescriptorSignatureImplementationsReceipt.files.length, 18);
  assert.deepEqual(jvmRows, exceptionFinal.predecessorRetainedSources.filter(row => row.path.startsWith('compiler-port-jvm-descriptor-signatures/')));
  await checked(description.log);
  return { description, port, state, bytes, receipt, command, args, actual, towerOptions, towerFinal, mainEntryOptions, mainEntryFinal,
    psiOptions, psiFinal, exceptionOptions, exceptionFinal };
}

export async function reopenPsiNativeModuleContracts(build) {
  const { port, description, receipt, actual, exceptionOptions, psiOptions, exceptionFinal } = build;
  const sourceRoot = psiOptions.sourceRoot;
  async function component(key, receiptName) {
    const outputRoot = path.join(description.buildRoot, 'components', key), receiptPath = path.join(outputRoot, receiptName);
    const bytes = await readRegular(receiptPath, 64 * 1024 * 1024), value = JSON.parse(bytes);
    assert.deepEqual(value, receipt[key]);
    return { outputRoot, receiptPath, receipt: value, receiptSha256: sha256(bytes),
      commonSources: (value.files ?? []).map(row => path.join(outputRoot, row.path)) };
  }
  const serializer = await component('serializerOutputReceipt', 'serializer-output-inputs.json');
  const comments = await component('serializerCommentTypeNamesReceipt', 'serializer-comment-type-names-inputs.json');
  const modules = await import(pathToFileURL(path.join(port, 'module-relative-paths/prepare.mjs')));
  const moduleFinal = await modules.reconstructModuleRequirePathPredecessorSelection({ sourceRoot,
    outputRoot: path.join(description.buildRoot, 'components/moduleRequirePathsReceipt'), preparedCommentTypeNames: comments,
    commentTypeNameOptions: { sourceRoot, outputRoot: comments.outputRoot, preparedSerializerOutput: serializer,
      serializerOutputOptions: { sourceRoot, outputRoot: serializer.outputRoot } }, retainedSources: actual });
  assert.deepEqual(moduleFinal, receipt.moduleRequirePathsFinalReceipt);
  assert.deepEqual(moduleFinal.final.inputs, actual.map(({ path, filename, bytes, sha256 }) => ({ path, filename, bytes, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path)));
  const native = await import(pathToFileURL(path.join(port, 'native-js-output-profile/prepare.mjs')));
  const inputs = await native.inspectNativeJsOutputInputs(sourceRoot);
  const selected = await native.inspectNativeJsOutputSelection(inputs, actual, { excludeTarget: true });
  const recorded = receipt.nativeJsOutputProfileFinalReceipt;
  for (const field of ['inspectedFiles', 'inspectedBytes', 'inventorySha256', 'incoming', 'existingProfileClosure'])
    assert.deepEqual(selected[field], recorded[field]);
  assert.deepEqual(selected.splitBoundaries.map(({ source, ...pin }) => pin), recorded.existingSplitBindings);
  const boundaries = rows => rows.map(({ originalPath, path, filename, bytes, sha256 }) => ({ originalPath, path, filename, bytes, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(boundaries(selected.boundaries), boundaries(recorded.retainedBoundaryBindings));
  const phases = await component('loweringPhaseFactoriesReceipt', 'receipt.json');
  const nativeFirst = await component('nativeFirstPhaseSourceProfileReceipt', 'receipt.json');
  const phase = await import(pathToFileURL(path.join(port, 'native-js-output-profile/phase-boundary.mjs')));
  const reopened = await phase.bindNativeLoweringPhaseBoundary({ sourceRoot,
    boundary: { sourceRoot, outputRoot: phases.outputRoot, expectedReceiptSha256: phases.receiptSha256,
      nativeFirstPhaseProfile: { sourceRoot, outputRoot: nativeFirst.outputRoot, expectedReceiptSha256: nativeFirst.receiptSha256 },
      compilerExceptionProfile: exceptionOptions, firPsiViewsProfile: psiOptions, firTowerModeMapProfile: build.towerOptions,
      officialMainEntryProfile: build.mainEntryOptions },
    retainedSources: actual, recordedPropertyImports: receipt.propertyImports.imports,
    requiredBoundaries: inputs.lock.requiredBoundaries, source: inputs.lock.source });
  assert.deepEqual(reopened.receipt, recorded.loweringPhaseFactoryBinding);
  assert.equal(recorded.loweringPhaseFactoryBinding.actualCompilerGraphPreservedForPsiLexicalAndModule, true);
  if (build.towerOptions) assert.equal(recorded.loweringPhaseFactoryBinding.actualCompilerGraphPreservedForTowerLexicalAndModule, true);
  if (build.mainEntryOptions) assert.equal(recorded.loweringPhaseFactoryBinding.actualCompilerGraphPreservedForMainEntryLexicalAndModule, true);
  const fir = await import(pathToFileURL(path.join(port, 'fir-storage-source-profile/prepare.mjs')));
  const firFinal = await fir.verifyFinalFirStorageSourceProfile({
    profileRoot: path.join(description.buildRoot, 'components/firStorageSourceProfileReceipt'),
    retainedSources: exceptionFinal.predecessorRetainedSources,
    allowedAddedImports: ['kotlin.jvm.*', ...receipt.propertyImports.imports,
      'org.jetbrains.kotlin.portable.assertions.compilerAssert as assert'] });
  assert.deepEqual(firFinal, receipt.firStorageSourceProfileFinalReceipt);
  assert.equal(firFinal.guard.portableJvmClassNameSources.length, 6);
  const jvm = await import(pathToFileURL(path.join(port, 'jvm-descriptor-signature-implementations/prepare.mjs')));
  const jvmComponent = await component('jvmDescriptorSignatureImplementationsReceipt', 'receipt.json');
  const jvmFinal = await jvm.verifyFinalJvmDescriptorSignatureImplementations({ outputRoot: jvmComponent.outputRoot,
    expectedReceiptSha256: jvmComponent.receiptSha256, retainedSources: exceptionFinal.predecessorRetainedSources,
    recordedPropertyImports: receipt.propertyImports.imports });
  assert.deepEqual(jvmFinal.receipt, receipt.jvmDescriptorSignatureImplementationsFinalReceipt);
}

export async function compareAuthenticCompilerInputs(build, baseline) {
  assert.deepEqual(logicalIdentity(build.psiFinal.predecessorRetainedSources), logicalIdentity(baseline.retainedSources),
    'The full PSI inverse must equal the authentic 1307-diagnostic predecessor');
  const baselineArgs = (await readRegular(path.join(baseline.buildRoot, 'compiler-klib.args'), 16 * 1024 * 1024))
    .toString().trimEnd().split('\n').map(JSON.parse);
  const oldCommand = baseline.receipt.commands.find(row => row.phase === 'official-compiler-source-to-wasmjs-klib');
  assert.deepEqual(build.receipt.bootstrap, baseline.receipt.bootstrap);
  const currentPins = await compilerInputPins(build.command.command, build.args, build.receipt.bootstrap, build.receipt.hostLibraries);
  const oldPins = await compilerInputPins(oldCommand.command, baselineArgs, baseline.receipt.bootstrap, baseline.receipt.hostLibraries);
  const normalizedPins = pins => pins.map(({ filename, ...pin }) => ({ file: path.basename(filename), ...pin }));
  assert.deepEqual(normalizedPins(currentPins), normalizedPins(oldPins), 'Compiler or complete host library bytes changed');
  const normalizeCommand = command => {
    const value = [...command], index = value.indexOf('-cp'); assert(index >= 0);
    value[index + 1] = value[index + 1].split(path.delimiter).map(filename => path.basename(filename)).join(path.delimiter);
    value[value.length - 1] = '@<authenticated-arguments>'; return value;
  };
  assert.deepEqual(normalizeCommand(build.command.command), normalizeCommand(oldCommand.command));
  for (const key of ['maximumHeap', 'timeoutMs']) assert.equal(build.command[key], oldCommand[key]);
  const projected = projectControlArguments(build.args, build.actual, baseline.retainedSources, baseline.buildRoot);
  const libraries = projected.indexOf('-libraries');
  assert(libraries >= 0 && projected.filter(value => value === '-libraries').length === 1);
  assert.equal(baselineArgs.indexOf('-libraries'), libraries);
  projected[libraries + 1] = baselineArgs[libraries + 1]; // Complete library content/order was checked above.
  assert.deepEqual(projected, baselineArgs, 'Non-source compiler arguments changed');
  return { orderedSources: 3571, compilerAndLibraryFiles: currentPins.length,
    completeSourceInverseEqualsBaseline: true, onlySourceAndOutputOwnersRelocated: true,
    nonSourceArgumentsUnchanged: true, baselineCompilerExitCode: oldCommand.exitCode, compilerExitCode: build.command.exitCode };
}

async function verifyInventory(pin, root, outputPrefix) {
  const inventory = JSON.parse(await checked(pin)), paths = new Set();
  assert.equal(inventory.sourceRoot, root);
  for (const row of inventory.records) {
    relativePath(row.path); assert(!paths.has(row.path)); paths.add(row.path);
    if (outputPrefix) assert(row.path.startsWith(outputPrefix + '/'));
    const bytes = await readRegular(path.join(root, row.path), 128 * 1024 * 1024);
    assert.deepEqual(identity(bytes), { bytes: row.bytes, sha256: row.sha256 }, 'Inventory input changed: ' + row.path);
  }
  for (const external of inventory.externalInputs ?? []) await checked(external);
  assert(inventory.records.length > 0);
}

async function verifyToolInputs(pins, names) {
  assert(Array.isArray(pins)); assert.equal(new Set(pins.map(pin => pin.filename)).size, pins.length);
  for (const pin of pins) await checked(pin);
  for (const name of names) {
    const filename = path.join(here, name), pin = pins.find(row => row.filename === filename);
    assert(pin, 'Executed tool/input is not pinned: ' + name);
    assert.deepEqual(await checked(pin), await readRegular(filename));
  }
}

export async function verifyPsiRuntimeEvidence(evidence, buildState) {
  const runtime = JSON.parse(await checked(evidence.runtime.receipt));
  const runtimeStatus = JSON.parse(await checked(evidence.runtime.status));
  assert.equal(runtimeStatus.state, 'exited'); assert.equal(runtimeStatus.exitCode, 0); await checked(evidence.runtime.log);
  assert.equal(path.basename(runtimeStatus.argv[0]), 'node');
  assert.equal(path.resolve(evidence.build.snapshotRoot, runtimeStatus.argv[1]), path.join(here, 'runtime-probe.mjs'));
  assert.equal(runtimeStatus.argv[2], runtimeStatus.sourceRoot);
  assert.equal(runtimeStatus.argv[3], evidence.baseline.buildRoot);
  assert.equal(path.resolve(evidence.build.snapshotRoot, runtimeStatus.argv[4]), path.dirname(evidence.runtime.receipt.filename));
  assert(runtimeStatus.finishedUnix >= runtimeStatus.startedUnix);
  assert(buildState.startedUnix >= runtimeStatus.finishedUnix, 'Runtime compiler must exit before the whole compiler starts');
  assert.equal(runtime.kind, 'fir-lighttree-null-psi-view-method-boundary-runtime');
  assert.equal(runtime.result, 'pass'); assert.equal(runtime.inputsUnchanged, true);
  assert.equal(runtime.fullFirToIrExecuted, false); assert.equal(runtime.fullCompilerBuilt, false);
  assert.deepEqual(runtime.commands.map(row => row.phase), ['five-complete-original-source-jvm-typecheck',
    'original-boundary-jvm-build', 'original-boundary-jvm-observe', 'genuine-fir-source-agreement-jvm-build',
    'genuine-fir-source-agreement-jvm-observe', 'common-boundary-jvm-build', 'common-boundary-jvm-observe',
    'common-boundary-wasmjs-klib-build', 'common-boundary-wasmjs-module-build', 'actual-node-wasmjs-observe']);
  assert(runtime.commands.every(row => row.exitCode === 0));
  await verifyToolInputs(runtime.inputPins, ['runtime-probe.mjs', 'runtime-projection.mjs', 'RuntimePayloadProbe.kt.in',
    'RuntimeObservationProbe.kt', 'RuntimeActualJvmProbe.kt', 'RuntimeJvmProbe.kt', 'RuntimeWasmProbe.kt',
    'transform.mjs', 'sources.lock.json', 'selection.lock.json']);
  const profilePin = runtime.inputPins.find(pin => pin.filename === evidence.sourceLock.filename);
  assert(profilePin); assert.equal(profilePin.sha256, evidence.sourceLock.sha256);
  const sourceLock = JSON.parse(await checked(evidence.sourceLock)), originalFiles = [];
  for (const pin of sourceLock.targets) {
    const filename = path.join(runtimeStatus.sourceRoot, pin.path), input = runtime.inputPins.find(row => row.filename === filename);
    assert(input); const original = await checked(input);
    assert.deepEqual(identity(original), { bytes: pin.bytes, sha256: pin.sha256 });
    const actualFilename = path.join(path.dirname(evidence.runtime.receipt.filename), 'actual-original', pin.path);
    assert.equal((await readRegular(actualFilename)).toString(), original.toString()
      .replaceAll(/\bcom\.intellij\.(?!platform\.syntax\b)/g, 'org.jetbrains.kotlin.com.intellij.'),
    'Original JVM typecheck must use each complete pinned file with only compiler-embedding package relocation');
    originalFiles.push(actualFilename);
  }
  assert.deepEqual(runtime.commands[0].command.slice(-TARGETS.length), originalFiles);
  for (const pin of runtime.artifacts) {
    relativePath(pin.path); await checked({ filename: path.join(path.dirname(evidence.runtime.receipt.filename), pin.path), ...pin });
  }
  const comparison = runtime.comparison;
  for (const [filename, digest] of [['original-observations.txt', comparison.originalJvmSha256],
    ['common-observations.txt', comparison.commonJvmSha256], ['wasm-observations.txt', comparison.actualNodeWasmSha256],
    ['genuine-agreement-observations.txt', runtime.genuineOriginalAgreement.sha256]]) {
    const pin = runtime.artifacts.find(row => row.path === filename); assert(pin);
    const bytes = await checked({ filename: path.join(path.dirname(evidence.runtime.receipt.filename), filename), ...pin });
    assert.equal(sha256(bytes), digest, 'Runtime comparison is not bound to its raw output');
    assert.equal(bytes.toString().trimEnd().split('\n').length, filename.startsWith('genuine-') ?
      runtime.genuineOriginalAgreement.observations : comparison.observations);
  }
  assert.equal(comparison.originalJvmSha256, comparison.commonJvmSha256);
  assert.equal(comparison.originalJvmSha256, comparison.actualNodeWasmSha256);
  assert.equal(comparison.originalJvmSha256, runtime.browser.sha256);
  assert.equal(runtime.browser.engine, 'Chromium'); assert.equal(runtime.browser.moduleWorker, true);
  assert.equal(runtime.browser.offlineAfterInitialization, true);
  assert.deepEqual(runtime.browser.externalRequests, []); assert.deepEqual(runtime.browser.offlineRequests, []);
  assert(runtime.genuineOriginalAgreement.observations > 0);
  const fixturePolicy = JSON.parse(await checked(evidence.runtime.fixturePolicy));
  assert.equal(fixturePolicy.kind, 'genuine-fir-null-source-fixture-policy'); assert.equal(fixturePolicy.result, 'pass');
  assert.deepEqual(fixturePolicy.runtimeReceipt, { bytes: evidence.runtime.receipt.bytes, sha256: evidence.runtime.receipt.sha256 });
  const actualProbe = await checked(fixturePolicy.probe);
  assert.equal(fixturePolicy.probe.filename, path.join(here, 'RuntimeActualJvmProbe.kt'));
  assert(actualProbe.toString().includes(fixturePolicy.policy));
  const primary = JSON.parse(await readRegular(path.join(here, '../closure.lock.json')));
  const builderPin = primary.files.find(pin => pin.path === fixturePolicy.originalBuilderInvariant.logical);
  assert(builderPin);
  const builder = await readRegular(path.join(runtimeStatus.sourceRoot, builderPin.path));
  assert.deepEqual(identity(builder), { bytes: builderPin.bytes, sha256: builderPin.sha256 });
  assert.deepEqual(identity(builder), { bytes: fixturePolicy.originalBuilderInvariant.bytes,
    sha256: fixturePolicy.originalBuilderInvariant.sha256 });
  assert(builder.toString().includes(fixturePolicy.originalBuilderInvariant.condition));
  for (const pin of fixturePolicy.originalMeasuredBodies) {
    const original = await readRegular(path.join(runtimeStatus.sourceRoot, pin.logical));
    const body = balancedSpan(original.toString(), pin.anchor).text;
    assert.deepEqual(identity(Buffer.from(body)), { bytes: pin.bytes, sha256: pin.sha256 });
    assert.equal(pin.readsOrigin, false); assert(!/\borigin\b/.test(body));
  }
  const genuineOutput = await readRegular(path.join(path.dirname(evidence.runtime.receipt.filename), 'genuine-agreement-observations.txt'));
  assert(genuineOutput.toString().split('\n').includes(fixturePolicy.observation));
  return runtime;
}

export async function verifyPsiEvidence(filename = path.join(here, 'evidence/current-foundation-v1.json')) {
  const evidence = JSON.parse(await readRegular(filename));
  assert.equal(evidence.kind, 'fir-lighttree-psi-current-foundation-evidence-v1'); assert.equal(evidence.result, 'pass');
  for (const pin of evidence.shippingInputs) await checked(pin);
  assert.deepEqual(await checked(evidence.sourceLock), await readRegular(path.join(here, 'sources.lock.json')));
  assert.deepEqual(await checked(evidence.selectionLock), await readRegular(path.join(here, 'selection.lock.json')));
  const selected = JSON.parse(await checked(evidence.selectionLock));
  const historicalBytes = await checked(evidence.baseline.qualification);
  assert.deepEqual(identity(historicalBytes), selected.qualifiedEvidence);
  const historical = JSON.parse(historicalBytes);
  assert.equal(historical.currentFoundationQualified, true); assert.equal(historical.result, 'pass');
  assert.equal(historical.build.buildRoot, evidence.baseline.buildRoot);
  const oldState = JSON.parse(await checked(historical.build.status));
  assert.equal(oldState.state, 'exited'); assert.equal(oldState.exitCode, 1); assert.equal(oldState.frozenInputsUnchanged, true);
  assert.deepEqual(oldState.changedInputs, []); await checked(historical.build.log);
  assert.equal(evidence.baseline.log, historical.build.log.filename);
  const build = await reopenPsiBuild(evidence.build);
  const baseline = await actualPredecessor(evidence.baseline.buildRoot);
  const compilerComparison = await compareAuthenticCompilerInputs(build, baseline);
  assert.deepEqual(compilerComparison, evidence.compilerComparison);
  await verifyInventory(evidence.frozenInputs, evidence.build.snapshotRoot);
  await verifyInventory(evidence.outputInventory, evidence.build.snapshotRoot,
    path.relative(evidence.build.snapshotRoot, evidence.build.buildRoot));
  await reopenPsiNativeModuleContracts(build);
  const runtime = await verifyPsiRuntimeEvidence(evidence, build.state);
  const comparison = runtime.comparison;
  const guards = JSON.parse(await checked(evidence.guards.receipt));
  const guardState = JSON.parse(await checked(evidence.guards.status));
  assert.equal(guardState.state, 'exited'); assert.equal(guardState.exitCode, 0); await checked(evidence.guards.log);
  assert.equal(guardState.sourceRoot, evidence.build.snapshotRoot);
  assert.deepEqual(guardState.argv.slice(1), ['--test', path.join(here, 'prepare.test.mjs')]);
  assert.equal(guardState.frozenInputsUnchanged, true); assert.deepEqual(guardState.changedInputs, []);
  assert.equal(guards.sourceLockSha256, evidence.sourceLock.sha256);
  assert.equal(guards.selectionLockSha256, evidence.selectionLock.sha256);
  assert.equal(guards.toolInputsUnchanged, true);
  await verifyToolInputs(guards.toolInputs, ['prepare.test.mjs', 'fixture.mjs', 'prepare.mjs', 'transform.mjs',
    'sources.lock.json', 'selection.lock.json']);
  assert((await checked(evidence.guards.log)).toString().includes(JSON.stringify({ guardReceipt: evidence.guards.receipt.filename,
    rejected: 10, sources: 3571 })), 'Unit output receipt is not bound to the actual test log');
  assert.equal(guards.actualSources, 3571); assert.equal(guards.restoredSourceState, true);
  assert.equal(guards.exactPreviousExceptionInverse, true); assert.equal(guards.cases.length, 10);
  assert(guards.cases.every(row => row.rejected));
  assert.deepEqual(await checked(evidence.diagnosticDriftLock), await readRegular(path.join(here, 'diagnostic-drift.lock.json')));
  const driftGuards = JSON.parse(await checked(evidence.driftGuards.receipt));
  const driftGuardState = JSON.parse(await checked(evidence.driftGuards.status));
  assert.equal(driftGuardState.state, 'exited'); assert.equal(driftGuardState.exitCode, 0);
  assert.equal(driftGuardState.sourceRoot, evidence.build.snapshotRoot);
  assert.deepEqual(driftGuardState.argv.slice(1), ['--test', path.join(here, 'diagnostics.test.mjs')]);
  assert.equal(driftGuardState.frozenInputsUnchanged, true); assert.deepEqual(driftGuardState.changedInputs, []);
  assert(driftGuardState.startedUnix >= build.state.finishedUnix);
  assert.equal(driftGuards.kind, 'fir-psi-diagnostic-drift-guards'); assert.equal(driftGuards.result, 'pass');
  assert.equal(driftGuards.driftLockSha256, evidence.diagnosticDriftLock.sha256);
  assert.equal(driftGuards.sourceLockSha256, evidence.sourceLock.sha256);
  assert.deepEqual(driftGuards.buildReceipts, { baseline: selected.actualBuildReceipt, current: identity(build.bytes) });
  assert.equal(driftGuards.toolInputsUnchanged, true); assert.equal(driftGuards.originalsAndLogsUnmodified, true);
  await verifyToolInputs(driftGuards.toolInputs, ['diagnostics.test.mjs', 'diagnostics.mjs', 'diagnostic-drift.lock.json',
    'transform.mjs', 'sources.lock.json', 'selection.lock.json']);
  for (const pin of driftGuards.inputs) await checked(pin);
  assert.equal(driftGuards.rawNewOther, 9); assert.equal(driftGuards.reviewed, 9); assert.equal(driftGuards.unreviewed, 0);
  assert.equal(driftGuards.cases.length, 12); assert(driftGuards.cases.every(row => row.rejected && row.reasonMatched));
  assert((await checked(evidence.driftGuards.log)).toString().includes(JSON.stringify({
    diagnosticGuardReceipt: evidence.driftGuards.receipt.filename, negativeCases: 12 })));
  const wholeGuards = JSON.parse(await checked(evidence.wholeGuards.receipt));
  const wholeGuardState = JSON.parse(await checked(evidence.wholeGuards.status));
  assert.equal(wholeGuardState.state, 'exited'); assert.equal(wholeGuardState.exitCode, 0);
  assert.equal(wholeGuardState.sourceRoot, evidence.build.snapshotRoot);
  assert.deepEqual(wholeGuardState.argv.slice(1), [path.join(here, 'whole-guards.mjs'), evidence.wholeGuards.configuration.filename]);
  const guardConfiguration = JSON.parse(await checked(evidence.wholeGuards.configuration));
  assert.deepEqual(guardConfiguration.build, evidence.build);
  assert.equal(guardConfiguration.outputRoot, path.dirname(evidence.wholeGuards.receipt.filename));
  assert.equal(wholeGuards.sourceLockSha256, evidence.sourceLock.sha256);
  assert.equal(wholeGuards.selectionLockSha256, evidence.selectionLock.sha256);
  assert.equal(wholeGuards.toolInputsUnchanged, true);
  await verifyToolInputs(wholeGuards.toolInputs, ['whole-guards.mjs', 'verify.mjs', 'diagnostics.mjs', 'diagnostic-drift.lock.json', 'fixture.mjs',
    'prepare.mjs', 'transform.mjs', 'sources.lock.json', 'selection.lock.json']);
  assert(wholeGuardState.startedUnix >= build.state.finishedUnix, 'No output mutation while the compiler is running');
  assert(wholeGuardState.startedUnix >= driftGuardState.finishedUnix, 'Diagnostic inputs must remain stable during their checks');
  await checked(evidence.wholeGuards.log);
  assert.equal(wholeGuards.buildReceiptSha256, evidence.build.receipt.sha256);
  assert.equal(wholeGuards.restoredSourceState, true); assert(wholeGuards.cases.length >= 3);
  assert(wholeGuards.cases.every(row => row.rejected && row.reasonMatched));
  const diagnostics = JSON.parse(await checked(evidence.diagnostics));
  assert.deepEqual(diagnostics, await comparePsiDiagnostics(evidence.build.buildRoot, evidence.build.log.filename,
    baseline.buildRoot, evidence.baseline.log));
  assert.equal(diagnostics.baselineTotal, 1307); assert.equal(diagnostics.baselineProfileEntries.length, 52);
  assert.equal(diagnostics.currentTotal, 1262); assert.equal(diagnostics.currentProfileEntries.length, 10);
  assert.deepEqual(diagnostics.driftLock, evidence.diagnosticDriftLock);
  assert.equal(diagnostics.newProfileDiagnosticEntries.length, 0); assert.equal(diagnostics.newOtherDiagnosticEntries.length, 9);
  assert.equal(diagnostics.reviewedDrift.reviewedNewDiagnosticEntries.length, 9);
  assert.equal(diagnostics.reviewedDrift.unreviewedNewDiagnosticEntries.length, 0);
  assert.equal(diagnostics.reviewedDrift.reviewedMessagesAllAtPreexistingFailureSites, true);
  assert.equal(evidence.fullCompilerBuilt, false); assert.equal(evidence.fullFirToIrWasmExecuted, false);
  return { result: 'pass', sourceFiles: 3571, profileFiles: 5, retainedJvmSignatureSources: 18,
    compilerComparison, diagnostics: { before: diagnostics.baselineTotal, after: diagnostics.currentTotal,
      profileBefore: diagnostics.baselineProfileEntries.length, profileAfter: diagnostics.currentProfileEntries.length,
      newProfile: 0, rawNewOther: 9, reviewedDrift: 9, unreviewedNewOther: 0 }, methodBoundaryObservations: comparison.observations,
    genuineJvmObservations: runtime.genuineOriginalAgreement.observations, chromiumWorkers: 1,
    sourceGuards: guards.cases.length + wholeGuards.cases.length, diagnosticGuards: driftGuards.cases.length,
    fullCompilerBuilt: false, fullFirToIrWasmExecuted: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await verifyPsiEvidence(process.argv[2])));
