import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { verifyOfficialMainEntryFinalSources } from '../official-main-entry/prepare.mjs';
import { TARGET as ENTRY } from '../official-main-entry/transform.mjs';
import { TARGETS, RECIPES, transformCommonDequeApi } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const checked = (bytes, pin, message) => {
  assert.deepEqual(identity(bytes), { bytes: pin.bytes, sha256: pin.sha256 }, message); return bytes;
};
const rowKeys = ['path', 'filename', 'bytes', 'sha256', 'compile'];
function outputOwner(root) {
  assert(path.isAbsolute(root) && root === path.resolve(root) && root.startsWith(path.join(repository, 'out') + path.sep),
    'Common deque output must have a canonical owner under this repository out/');
}

export async function readCommonDequeInputs() {
  const lockBytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
  const primaryBytes = await readRegular(path.join(here, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
  assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'common-deque-api-composition');
  assert.deepEqual(lock.source, primary.source); assert.equal(lock.primaryClosureSha256, sha256(primaryBytes));
  assert.deepEqual(lock.targets, TARGETS); assert.deepEqual(lock.recipes, RECIPES);
  assert.deepEqual(lock.addedSources, []); assert.deepEqual(lock.sourceSetExclusions, []);
  for (const pin of lock.dependencies) verifyFile(await readRegular(path.resolve(here, pin.path)), pin);
  const priorBytes = await readRegular(path.join(here, '../official-main-entry/sources.lock.json'));
  assert.equal(sha256(priorBytes), lock.officialMainSourceLockSha256);
  const prior = JSON.parse(priorBytes);
  const priorSelection = JSON.parse(verifyFile(await readRegular(path.join(here, '../official-main-entry/selection.lock.json')), prior.selection));
  const selected = JSON.parse(verifyFile(await readRegular(path.join(here, 'selection.lock.json')), lock.selection));
  assert.equal(selected.schemaVersion, 1); assert.equal(selected.kind, 'qualified-official-main-entry-output-selection');
  assert.equal(selected.rows.length, 3571); assert.equal(selected.compilerExitCode, 1);
  assert.equal(selected.baselineDiagnosticCount, 1250); assert.equal(selected.currentFoundationQualified, true);
  assert.equal(selected.jvmSignatureSources, 18); assert.deepEqual(selected.source, lock.source);
  assert.equal(selected.foundationCommit, '6d520fcc01a5eedb2edeb83ae36dea72f7394850');
  assert.equal(selected.officialMainSourceLockSha256, lock.officialMainSourceLockSha256);
  const expectedRows = priorSelection.rows.map(row => row.path === ENTRY ? {
    ...row, ownerRelative: 'components/officialMainEntryReceipt/' + row.path,
    bytes: prior.assembledOutput.bytes, sha256: prior.assembledOutput.sha256,
  } : row);
  assert.deepEqual(selected.rows, expectedRows, 'Complete qualified official-main output selection changed');
  assert.deepEqual(lock.recordedPropertyImports, prior.recordedPropertyImports);
  assert.deepEqual(lock.files.map(row => row.path), TARGETS);
  for (const file of lock.files) {
    const original = primary.files.find(row => row.path === file.path);
    assert(original && original.compile === true);
    assert.deepEqual(file.original, { path: original.path, bytes: original.bytes, sha256: original.sha256, gitBlob: original.gitBlob });
    const selectedRow = selected.rows.find(row => row.path === file.path);
    assert.deepEqual(file.incoming, { path: file.path, bytes: selectedRow.bytes, sha256: selectedRow.sha256 });
  }
  return { lockBytes, lock, selected };
}

export async function inspectCommonDequeApiSelection(rows, input, { phase, outputRoot, priorBuildRoot }) {
  assert(['before', 'after'].includes(phase)); outputOwner(outputRoot); outputOwner(priorBuildRoot);
  assert(Array.isArray(rows)); assert.equal(rows.length, 3571, 'Complete 3571-source common deque selection required');
  const paths = new Set(), owners = new Set(), targets = new Map(input.lock.files.map(row => [row.path, row]));
  for (const [index, row] of rows.entries()) {
    const baseline = input.selected.rows[index];
    assert.deepEqual(Object.keys(row), rowKeys, 'Complete common deque row metadata and key order required');
    assert.equal(row.compile, true, 'Inactive common deque compiler input'); relativePath(row.path);
    relativePath(baseline.ownerRelative);
    assert.equal(row.path, baseline.path, 'Actual common deque source selection or order changed');
    assert(!paths.has(row.path) && !owners.has(row.filename), 'Duplicate common deque logical source or owner');
    paths.add(row.path); owners.add(row.filename);
    const changed = phase === 'after' && targets.has(row.path);
    assert.equal(row.filename, changed ? path.join(outputRoot, row.path) : path.join(priorBuildRoot, baseline.ownerRelative),
      'Noncanonical common deque source owner: ' + row.path);
    const expected = changed ? targets.get(row.path).outgoing : baseline;
    assert.deepEqual({ bytes: row.bytes, sha256: row.sha256 }, { bytes: expected.bytes, sha256: expected.sha256 },
      'Actual common deque source body changed: ' + row.path);
  }
  assert.equal(rows.filter(row => row.path.startsWith('compiler-port-jvm-descriptor-signatures/')).length, 18);
  for (let offset = 0; offset < rows.length; offset += 24) {
    const batch = await Promise.allSettled(rows.slice(offset, offset + 24).map(async row => {
      const bytes = checked(await readRegular(row.filename), row, 'Selected common deque source bytes changed: ' + row.path);
      if (targets.has(row.path)) {
        const file = targets.get(row.path), inverse = transformCommonDequeApi(row.path, bytes, { reverse: phase === 'after' });
        checked(inverse, phase === 'after' ? file.incoming : file.outgoing, 'Complete common deque transform/inverse changed');
      }
    }));
    for (const result of batch) if (result.status !== 'fulfilled') throw result.reason;
  }
  return { sources: structuredClone(rows), jvmSignatureSources: 18, replacedPaths: phase === 'after' ? TARGETS : [],
    scope: 'Complete ordered selected files, canonical owners, metadata and bytes; six exact deque API adaptations' };
}

async function verifyOfficialMainPredecessor(profile, input, retainedSources, recordedPropertyImports) {
  assert(profile && path.isAbsolute(profile.sourceRoot) && profile.sourceRoot === path.resolve(profile.sourceRoot));
  outputOwner(profile.outputRoot);
  assert.equal(path.basename(profile.outputRoot), 'officialMainEntryReceipt');
  assert.equal(path.basename(path.dirname(profile.outputRoot)), 'components');
  assert.match(profile.expectedReceiptSha256 ?? '', /^[a-f0-9]{64}$/);
  const receiptPath = path.join(profile.outputRoot, 'receipt.json'), bytes = await readRegular(receiptPath, 32 * 1024 * 1024);
  assert.equal(sha256(bytes), profile.expectedReceiptSha256, 'Previous official-main receipt changed');
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.kind, 'official-main-entry-preparation'); assert.equal(receipt.sourceRoot, profile.sourceRoot);
  assert.equal(receipt.sourceLockSha256, input.lock.officialMainSourceLockSha256);
  const replacements = new Map(receipt.files.map(row => [row.before.path, row.after]));
  const predecessor = receipt.selection.sources.map(row => structuredClone(replacements.get(row.path) ?? row));
  assert.deepEqual(retainedSources, predecessor, 'Common deque predecessor must be the complete actual official-main output graph');
  const final = await verifyOfficialMainEntryFinalSources({ ...profile, retainedSources, recordedPropertyImports });
  return { profile: { sourceRoot: profile.sourceRoot, outputRoot: profile.outputRoot,
    expectedReceiptSha256: profile.expectedReceiptSha256, sourceLockSha256: input.lock.officialMainSourceLockSha256 },
  finalReceipt: final.receipt };
}

async function originalSources(sourceRoot, input) {
  await assertNoSymlink(sourceRoot);
  return new Map(await Promise.all(input.lock.files.map(async file => {
    const original = verifyFile(await readRegular(path.join(sourceRoot, relativePath(file.path))), file.original);
    const portable = transformCommonDequeApi(file.path, original);
    checked(portable, file.rawOutgoing, 'Complete original-source deque transformation changed');
    assert.deepEqual(transformCommonDequeApi(file.path, portable, { reverse: true }), original);
    return [file.path, original];
  })));
}

function receiptFor(input, sourceRoot, selected, previousOfficialMain, files) {
  return { schemaVersion: 1, kind: 'common-deque-api-preparation', source: input.lock.source,
    sourceRoot, sourceLockSha256: sha256(input.lockBytes), baselineSelectionSha256: input.lock.selection.sha256,
    previousOfficialMain: previousOfficialMain.profile, previousOfficialMainFinalReceipt: previousOfficialMain.finalReceipt,
    selection: selected, files, replacedOriginalPaths: TARGETS, sourceSetExclusions: [], addedSources: [],
    completeOfficialAlgorithmsPreserved: true, dequeEndAndEmptyBehaviorPreserved: true,
    userSourceRewritten: false, fullCompilerBuilt: false, publicLanguageSupport: false };
}

export async function prepareCommonDequeApi({ sourceRoot, outputRoot, retainedSources, preparedOfficialMainEntryProfile, recordedPropertyImports }) {
  sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); outputOwner(outputRoot);
  await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
  assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep));
  const input = await readCommonDequeInputs(); assert.deepEqual(recordedPropertyImports, input.lock.recordedPropertyImports);
  assert(preparedOfficialMainEntryProfile); assert.equal(preparedOfficialMainEntryProfile.sourceRoot, sourceRoot);
  const priorBuildRoot = path.resolve(preparedOfficialMainEntryProfile.outputRoot, '../..');
  const selected = await inspectCommonDequeApiSelection(retainedSources, input, { phase: 'before', outputRoot, priorBuildRoot });
  const previous = await verifyOfficialMainPredecessor(preparedOfficialMainEntryProfile, input, selected.sources, recordedPropertyImports);
  const originals = await originalSources(sourceRoot, input), files = [];
  async function put(logical, bytes) {
    const filename = path.join(outputRoot, logical); await assertNoSymlink(filename);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename;
  }
  for (const file of input.lock.files) {
    const before = selected.sources.find(row => row.path === file.path), predecessor = await readRegular(before.filename);
    await put('original/' + file.path, originals.get(file.path)); await put('predecessor/' + file.path, predecessor);
    const transformed = transformCommonDequeApi(file.path, predecessor);
    checked(transformed, file.outgoing, 'Complete assembled common deque output changed');
    assert.deepEqual(transformCommonDequeApi(file.path, transformed, { reverse: true }), predecessor);
    const filename = await put(file.path, transformed), after = { ...before, filename, ...identity(transformed) };
    files.push({ before, after });
  }
  const receipt = receiptFor(input, sourceRoot, selected, previous, files), receiptPath = path.join(outputRoot, 'receipt.json');
  await writeJson(receiptPath, receipt);
  return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath, 32 * 1024 * 1024)),
    commonSources: files.map(row => row.after.filename), replacedOriginalPaths: TARGETS, sourceSetExclusions: [] };
}

export async function verifyCommonDequeApiFinalSources({ sourceRoot, outputRoot, retainedSources, expectedReceiptSha256, recordedPropertyImports }) {
  sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); outputOwner(outputRoot);
  assert.match(expectedReceiptSha256 ?? '', /^[a-f0-9]{64}$/);
  const input = await readCommonDequeInputs(); assert.deepEqual(recordedPropertyImports, input.lock.recordedPropertyImports);
  const bytes = await readRegular(path.join(outputRoot, 'receipt.json'), 32 * 1024 * 1024);
  assert.equal(sha256(bytes), expectedReceiptSha256, 'Common deque preparation receipt changed');
  const receipt = JSON.parse(bytes), priorBuildRoot = path.resolve(receipt.previousOfficialMain.outputRoot, '../..');
  assert.equal(receipt.sourceRoot, sourceRoot); assert.equal(receipt.previousOfficialMain.sourceRoot, sourceRoot);
  const selected = await inspectCommonDequeApiSelection(retainedSources, input, { phase: 'after', outputRoot, priorBuildRoot });
  const prior = await inspectCommonDequeApiSelection(receipt.selection.sources, input, { phase: 'before', outputRoot, priorBuildRoot });
  const originals = await originalSources(sourceRoot, input), files = [];
  for (const file of input.lock.files) {
    const before = prior.sources.find(row => row.path === file.path), filename = path.join(outputRoot, file.path);
    assert.deepEqual(await readRegular(path.join(outputRoot, 'original', file.path)), originals.get(file.path));
    const predecessor = checked(await readRegular(path.join(outputRoot, 'predecessor', file.path)), before, 'Common deque predecessor snapshot changed');
    const actual = await readRegular(filename);
    assert.deepEqual(transformCommonDequeApi(file.path, actual, { reverse: true }), predecessor, 'Complete common deque predecessor inverse changed');
    files.push({ before, after: { ...before, filename, ...identity(actual) } });
  }
  const replacements = new Map(files.map(row => [row.before.path, row.after]));
  assert.deepEqual(selected.sources, prior.sources.map(row => replacements.get(row.path) ?? row),
    'Common deque graph changed outside the six exact replacements');
  const originalsByPath = new Map(files.map(row => [row.before.path, row.before]));
  const predecessorRetainedSources = selected.sources.map(row => structuredClone(originalsByPath.get(row.path) ?? row));
  assert.deepEqual(predecessorRetainedSources, prior.sources, 'Complete common deque predecessor metadata/order changed');
  const previous = await verifyOfficialMainPredecessor(receipt.previousOfficialMain, input, predecessorRetainedSources, recordedPropertyImports);
  assert.deepEqual(receipt, receiptFor(input, sourceRoot, prior, previous, files));
  return { receipt: { schemaVersion: 1, kind: 'common-deque-api-final', sourceLockSha256: sha256(input.lockBytes),
    preparationReceiptSha256: expectedReceiptSha256, actualSelectedSources: selected.sources.length,
    actualSelectionSha256: sha256(Buffer.from(JSON.stringify(selected.sources))), predecessorSelectedSources: prior.sources.length,
    files, jvmSignatureSources: 18, previousOfficialMainFinalReceipt: previous.finalReceipt,
    completeSixSourceMetadataAndOrderPreserved: true, previousOfficialMainDeltaPreserved: true, noSourcesAddedOrExcluded: true,
    completeOfficialAlgorithmsPreserved: true, dequeEndAndEmptyBehaviorPreserved: true,
    userSourceRewritten: false, fullCompilerBuilt: false, publicLanguageSupport: false }, predecessorRetainedSources };
}
