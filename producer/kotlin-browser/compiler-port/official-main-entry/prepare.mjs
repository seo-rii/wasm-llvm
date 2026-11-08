import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { normalizeImports } from '../klib-signature-index/transform.mjs';
import { exceptionChanges, transform as transformException } from '../compiler-exception-attachment-profile/transform.mjs';
import { TARGET, TARGETS, RECIPE, OFFICIAL_LINKAGE, OFFICIAL_PHASE_TAIL, transformOfficialMainEntry } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const towerRelative = 'producer/kotlin-browser/compiler-port/fir-tower-mode-map';
const templateRelative = '../entry/BrowserCompilerPipeline.kt';
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const checked = (bytes, pin, message) => { assert.deepEqual(identity(bytes), { bytes: pin.bytes, sha256: pin.sha256 }, message); return bytes; };
const rowKeys = ['path', 'filename', 'bytes', 'sha256', 'compile'];
const underOut = (owner, root) => path.isAbsolute(root) && root === path.resolve(root) && root.startsWith(path.join(owner, 'out') + path.sep);

function outputOwner(root) {
  assert(underOut(repository, root), 'Official main output must have a canonical owner under this repository out/');
}

async function inputs() {
  const lockBytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
  const primaryBytes = await readRegular(path.join(here, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
  assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'official-main-entry-composition');
  assert.deepEqual(lock.source, primary.source); assert.equal(lock.primaryClosureSha256, sha256(primaryBytes));
  assert.deepEqual(lock.targets, TARGETS); assert.deepEqual(lock.recipes, RECIPE);
  assert.deepEqual(lock.officialPhases, { linkage: OFFICIAL_LINKAGE, tail: OFFICIAL_PHASE_TAIL });
  assert.deepEqual(lock.addedSources, []); assert.deepEqual(lock.sourceSetExclusions, []);
  for (const pin of lock.dependencies) verifyFile(await readRegular(path.resolve(here, pin.path)), pin);
  const selected = JSON.parse(verifyFile(await readRegular(path.join(here, 'selection.lock.json')), lock.selection));
  assert.equal(selected.schemaVersion, 1); assert.equal(selected.kind, 'actual-current-foundation-official-main-entry-selection');
  assert.equal(selected.rows.length, 3571); assert.equal(selected.compilerExitCode, 1);
  assert.equal(selected.baselineDiagnosticCount, 1250); assert.equal(selected.currentFoundationQualified, true);
  assert.equal(selected.jvmSignatureSources, 18); assert.deepEqual(selected.source, lock.source);
  assert.equal(lock.rawTemplate.path, templateRelative);
  const rawTemplate = verifyFile(await readRegular(path.resolve(here, templateRelative)), lock.rawTemplate);
  // The previous exception profile already wrapped this full entry. Preserve
  // that canonical predecessor, not just the older raw template.
  const original = transformException(rawTemplate, exceptionChanges(TARGET, rawTemplate));
  const transformed = transformOfficialMainEntry(TARGET, original);
  checked(original, lock.incoming, 'Complete exception-scoped entry predecessor changed');
  checked(transformed, lock.outgoing, 'Complete official-main entry changed');
  assert.deepEqual(transformOfficialMainEntry(TARGET, transformed, { reverse: true }), original);
  return { lockBytes, lock, selected, rawTemplate, original, transformed };
}

// Current production outputs use the current unchanged prior module. Only the
// exact qualified historical build may reopen its authenticated snapshot; a
// caller cannot supply arbitrary module code or an unqualified output owner.
export async function verifyTowerPredecessor({ sourceRoot, outputRoot, expectedReceiptSha256, retainedSources,
  recordedPropertyImports, towerSourceLockSha256 }) {
  assert(path.isAbsolute(sourceRoot) && sourceRoot === path.resolve(sourceRoot));
  assert(path.isAbsolute(outputRoot) && outputRoot === path.resolve(outputRoot));
  assert.equal(path.basename(outputRoot), 'firTowerModeMapReceipt');
  assert.equal(path.basename(path.dirname(outputRoot)), 'components');
  assert.match(expectedReceiptSha256 ?? '', /^[a-f0-9]{64}$/);
  const towerHere = path.join(repository, towerRelative);
  const qualification = JSON.parse(await readRegular(path.join(towerHere, 'evidence/current-foundation-v1.json')));
  assert.equal(qualification.result, 'pass');
  let verifierRepository = repository;
  if (!underOut(repository, outputRoot)) {
    assert.equal(outputRoot, path.join(qualification.build.buildRoot, 'components/firTowerModeMapReceipt'),
      'Only the exact qualified historical tower output owner is permitted');
    verifierRepository = qualification.build.snapshotRoot;
    assert.equal(qualification.build.buildRoot, path.join(verifierRepository, 'out', path.basename(qualification.build.buildRoot)));
  }
  const currentLockBytes = await readRegular(path.join(towerHere, 'sources.lock.json'));
  checked(currentLockBytes, qualification.sourceLock, 'Qualified tower source lock changed');
  assert.equal(sha256(currentLockBytes), towerSourceLockSha256, 'Official main predecessor tower recipe changed');
  const verifierHere = path.join(verifierRepository, towerRelative);
  assert.deepEqual(await readRegular(path.join(verifierHere, 'sources.lock.json')), currentLockBytes);
  const towerLock = JSON.parse(currentLockBytes);
  for (const pin of towerLock.dependencies) verifyFile(await readRegular(path.resolve(verifierHere, pin.path)), pin);
  const receiptPath = path.join(outputRoot, 'receipt.json'), bytes = await readRegular(receiptPath, 32 * 1024 * 1024);
  assert.equal(sha256(bytes), expectedReceiptSha256, 'Previous tower receipt changed');
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.kind, 'fir-private-tower-mode-map-preparation');
  assert.equal(receipt.sourceRoot, sourceRoot); assert.equal(receipt.sourceLockSha256, towerSourceLockSha256);
  assert.deepEqual(receipt.source, towerLock.source);
  assert.deepEqual(receipt.addedSources, []); assert.deepEqual(receipt.sourceSetExclusions, []);
  const replacements = new Map(receipt.files.map(row => [row.before.path, row.after]));
  const predecessor = receipt.selection.sources.map(row => structuredClone(replacements.get(row.path) ?? row));
  assert.deepEqual(retainedSources, predecessor, 'Official main predecessor must be the complete actual tower output graph');
  const previous = await import(pathToFileURL(path.join(verifierHere, 'prepare.mjs')));
  const final = await previous.verifyFirTowerModeMapFinalSources({ sourceRoot, outputRoot, expectedReceiptSha256,
    retainedSources, recordedPropertyImports });
  return { profile: { sourceRoot, outputRoot, expectedReceiptSha256, receiptPath,
    sourceLockSha256: towerSourceLockSha256, buildRoot: path.resolve(outputRoot, '../..'), verifierRepository },
  finalReceipt: final.receipt };
}

export async function inspectOfficialMainEntrySelection(rows, input, { phase, outputRoot, priorBuildRoot }) {
  assert(['before', 'after'].includes(phase));
  assert(Array.isArray(rows)); assert.equal(rows.length, input.selected.rows.length, 'Complete 3571-source official main selection required');
  const paths = new Set(), owners = new Set();
  // Reject selection/owner/metadata drift before opening selected source paths.
  for (const [index, row] of rows.entries()) {
    const baseline = input.selected.rows[index];
    assert.deepEqual(Object.keys(row), rowKeys, 'Complete official main row metadata and key order required');
    assert.equal(row.compile, true, 'Inactive official main compiler input'); relativePath(row.path);
    relativePath(baseline.ownerRelative);
    assert.equal(row.path, baseline.path, 'Actual official main source selection or order changed');
    assert(!paths.has(row.path) && !owners.has(row.filename), 'Duplicate official main logical source or owner');
    paths.add(row.path); owners.add(row.filename);
    const changed = phase === 'after' && row.path === TARGET;
    const expectedOwner = changed ? path.join(outputRoot, row.path) : path.join(priorBuildRoot, baseline.ownerRelative);
    assert.equal(row.filename, expectedOwner, 'Noncanonical official main source owner: ' + row.path);
    const expected = changed ? input.lock.assembledOutput : baseline;
    assert.deepEqual({ bytes: row.bytes, sha256: row.sha256 }, { bytes: expected.bytes, sha256: expected.sha256 },
      'Actual official main source body changed: ' + row.path);
  }
  assert.equal(rows.filter(row => row.path.startsWith('compiler-port-jvm-descriptor-signatures/')).length, 18);
  for (let offset = 0; offset < rows.length; offset += 24) {
    const batch = await Promise.allSettled(rows.slice(offset, offset + 24).map(async row => {
      const bytes = checked(await readRegular(row.filename), row, 'Selected official main source bytes changed: ' + row.path);
      if (row.path === TARGET) assert.deepEqual(normalizeImports(bytes, input.lock.recordedPropertyImports),
        phase === 'before' ? input.original : input.transformed, 'Complete official main entry/import changed');
    }));
    for (const result of batch) if (result.status !== 'fulfilled') throw result.reason;
  }
  return { sources: structuredClone(rows), jvmSignatureSources: 18, replacedPaths: phase === 'after' ? TARGETS : [],
    scope: 'Complete ordered selected files, owners, metadata and bytes; one entry delegates to unchanged official phases' };
}

function receiptFor(input, sourceRoot, selected, previousTower, files) {
  return { schemaVersion: 1, kind: 'official-main-entry-preparation', source: input.lock.source,
    sourceRoot, sourceLockSha256: sha256(input.lockBytes), baselineSelectionSha256: input.lock.selection.sha256,
    previousTower: previousTower.profile, previousTowerFinalReceipt: previousTower.finalReceipt,
    selection: selected, files, replacedOriginalPaths: TARGETS, sourceSetExclusions: [], addedSources: [],
    privatePreLoweringEntryGateRemoved: true, officialPhaseBodiesAndOrderPreserved: true,
    existingRequestExceptionHostPreserved: true, rawHistoricalTemplateUnchanged: true,
    handwrittenEntrySelectorOrWrapperAdded: false, fullCompilerBuilt: false, publicLanguageSupport: false };
}

export async function prepareOfficialMainEntry({ sourceRoot, outputRoot, retainedSources, preparedTowerModeMapProfile, recordedPropertyImports }) {
  sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); outputOwner(outputRoot);
  await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
  assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep));
  const input = await inputs(); assert.deepEqual(recordedPropertyImports, input.lock.recordedPropertyImports);
  assert(preparedTowerModeMapProfile); assert.equal(preparedTowerModeMapProfile.sourceRoot, sourceRoot);
  const priorBuildRoot = path.resolve(preparedTowerModeMapProfile.outputRoot, '../..');
  const selected = await inspectOfficialMainEntrySelection(retainedSources, input, { phase: 'before', outputRoot, priorBuildRoot });
  const previousTower = await verifyTowerPredecessor({ ...preparedTowerModeMapProfile, retainedSources: selected.sources,
    recordedPropertyImports, towerSourceLockSha256: input.lock.towerSourceLockSha256 });
  async function put(logical, bytes) {
    const filename = path.join(outputRoot, logical); await assertNoSymlink(filename);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename;
  }
  const before = selected.sources.find(row => row.path === TARGET), predecessor = await readRegular(before.filename);
  await put('raw-template/' + TARGET, input.rawTemplate);
  await put('original/' + TARGET, input.original); await put('predecessor/' + TARGET, predecessor);
  const transformed = transformOfficialMainEntry(TARGET, predecessor);
  assert.deepEqual(transformOfficialMainEntry(TARGET, transformed, { reverse: true }), predecessor);
  checked(transformed, input.lock.assembledOutput, 'Assembled official main output changed');
  const filename = await put(TARGET, transformed), after = { ...before, filename, ...identity(transformed) };
  const receipt = receiptFor(input, sourceRoot, selected, previousTower, [{ before, after }]), receiptPath = path.join(outputRoot, 'receipt.json');
  await writeJson(receiptPath, receipt);
  return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath, 32 * 1024 * 1024)),
    commonSources: [filename], replacedOriginalPaths: TARGETS, sourceSetExclusions: [] };
}

export async function verifyOfficialMainEntryFinalSources({ sourceRoot, outputRoot, retainedSources, expectedReceiptSha256, recordedPropertyImports }) {
  sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); outputOwner(outputRoot);
  assert.match(expectedReceiptSha256 ?? '', /^[a-f0-9]{64}$/);
  const input = await inputs(); assert.deepEqual(recordedPropertyImports, input.lock.recordedPropertyImports);
  const bytes = await readRegular(path.join(outputRoot, 'receipt.json'), 32 * 1024 * 1024);
  assert.equal(sha256(bytes), expectedReceiptSha256, 'Official main preparation receipt changed');
  const receipt = JSON.parse(bytes), priorBuildRoot = path.resolve(receipt.previousTower.outputRoot, '../..');
  const selected = await inspectOfficialMainEntrySelection(retainedSources, input, { phase: 'after', outputRoot, priorBuildRoot });
  const prior = await inspectOfficialMainEntrySelection(receipt.selection.sources, input, { phase: 'before', outputRoot, priorBuildRoot });
  const before = prior.sources.find(row => row.path === TARGET), filename = path.join(outputRoot, TARGET);
  assert.deepEqual(await readRegular(path.join(outputRoot, 'raw-template', TARGET)), input.rawTemplate);
  assert.deepEqual(await readRegular(path.join(outputRoot, 'original', TARGET)), input.original);
  const predecessor = checked(await readRegular(path.join(outputRoot, 'predecessor', TARGET)), before, 'Official main predecessor snapshot changed');
  const actual = await readRegular(filename);
  assert.deepEqual(transformOfficialMainEntry(TARGET, actual, { reverse: true }), predecessor, 'Complete official main predecessor inverse changed');
  const after = { ...before, filename, ...identity(actual) }, files = [{ before, after }];
  assert.deepEqual(selected.sources, prior.sources.map(row => row.path === TARGET ? after : row),
    'Official main graph changed outside the single exact replacement');
  const predecessorRetainedSources = selected.sources.map(row => structuredClone(row.path === TARGET ? before : row));
  assert.deepEqual(predecessorRetainedSources, prior.sources, 'Complete official main predecessor metadata/order changed');
  for (const [index, row] of predecessorRetainedSources.entries()) assert.deepEqual(Object.keys(row), Object.keys(prior.sources[index]));
  // Previous tower -> PSI -> exception guards receive their complete restored
  // graph. They never see the new entry, and none of their locks are weakened.
  const previousTower = await verifyTowerPredecessor({ ...receipt.previousTower, retainedSources: predecessorRetainedSources,
    recordedPropertyImports, towerSourceLockSha256: input.lock.towerSourceLockSha256 });
  assert.deepEqual(receipt, receiptFor(input, sourceRoot, prior, previousTower, files));
  return { receipt: { schemaVersion: 1, kind: 'official-main-entry-final', sourceLockSha256: sha256(input.lockBytes),
    preparationReceiptSha256: expectedReceiptSha256, actualSelectedSources: selected.sources.length,
    actualSelectionSha256: sha256(Buffer.from(JSON.stringify(selected.sources))), predecessorSelectedSources: prior.sources.length,
    files, jvmSignatureSources: 18, previousTowerFinalReceipt: previousTower.finalReceipt,
    completeOneRowMetadataAndOrderPreserved: true, previousTowerDeltaPreserved: true, noSourcesAddedOrExcluded: true,
    privatePreLoweringEntryGateRemoved: true, officialPhaseBodiesAndOrderPreserved: true,
    existingRequestExceptionHostPreserved: true, rawHistoricalTemplateUnchanged: true,
    handwrittenEntrySelectorOrWrapperAdded: false, fullCompilerBuilt: false, publicLanguageSupport: false }, predecessorRetainedSources };
}
