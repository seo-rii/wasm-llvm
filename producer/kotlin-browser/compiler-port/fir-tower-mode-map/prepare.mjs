import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { normalizeImports } from '../klib-signature-index/transform.mjs';
import { TARGET, TARGETS, MODES, RECIPE, transformTowerModeMap } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const psiRelative = 'producer/kotlin-browser/compiler-port/fir-lighttree-psi-views';
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const checked = (bytes, pin, message) => { assert.deepEqual(identity(bytes), { bytes: pin.bytes, sha256: pin.sha256 }, message); return bytes; };
const rowKeys = ['path', 'filename', 'bytes', 'sha256', 'compile'];
const underOut = (owner, root) => path.isAbsolute(root) && root === path.resolve(root) && root.startsWith(path.join(owner, 'out') + path.sep);

function outputOwner(root) {
  assert(underOut(repository, root), 'Tower map output must have a canonical owner under this repository out/');
}

async function inputs(sourceRoot) {
  const lockBytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
  const primaryBytes = await readRegular(path.join(here, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
  assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'fir-private-tower-mode-map');
  assert.deepEqual(lock.source, primary.source); assert.equal(lock.primaryClosureSha256, sha256(primaryBytes));
  assert.deepEqual(lock.targets.map(row => row.path), TARGETS); assert.deepEqual(lock.recipes, RECIPE);
  assert.deepEqual(lock.modes, MODES);
  for (const pin of lock.dependencies) verifyFile(await readRegular(path.resolve(here, pin.path)), pin);
  const selected = JSON.parse(verifyFile(await readRegular(path.join(here, 'selection.lock.json')), lock.selection));
  assert.equal(selected.kind, 'actual-current-foundation-fir-tower-mode-map-selection');
  assert.equal(selected.rows.length, 3571); assert.equal(selected.compilerExitCode, 1);
  assert.equal(selected.currentFoundationQualified, true); assert.equal(selected.jvmSignatureSources, 18);
  assert.deepEqual(selected.source, lock.source);
  assert.deepEqual(lock.targets[0], primary.files.find(row => row.path === TARGET));
  const original = verifyFile(await readRegular(path.join(sourceRoot, TARGET)), lock.targets[0]);
  const transformed = transformTowerModeMap(TARGET, original);
  checked(original, lock.incoming, 'Complete tower predecessor algorithm changed');
  checked(transformed, lock.outgoing, 'Complete tower map algorithm changed');
  assert.deepEqual(transformTowerModeMap(TARGET, transformed, { reverse: true }), original);
  return { lockBytes, lock, selected, original, transformed };
}

// The old verifier owns outputs relative to its module repository. Production
// must use the current unchanged module; only the exact qualified historical
// fixture may reopen that module in its authenticated historical snapshot.
export async function verifyPsiPredecessor({ sourceRoot, outputRoot, expectedReceiptSha256, retainedSources,
  recordedPropertyImports, psiSourceLockSha256 }) {
  assert(path.isAbsolute(sourceRoot) && sourceRoot === path.resolve(sourceRoot));
  assert(path.isAbsolute(outputRoot) && outputRoot === path.resolve(outputRoot));
  assert.equal(path.basename(outputRoot), 'firLightTreePsiViewsReceipt');
  assert.equal(path.basename(path.dirname(outputRoot)), 'components');
  assert.match(expectedReceiptSha256 ?? '', /^[a-f0-9]{64}$/);
  const psiHere = path.join(repository, psiRelative);
  const qualification = JSON.parse(await readRegular(path.join(psiHere, 'evidence/current-foundation-v1.json')));
  assert.equal(qualification.result, 'pass');
  let verifierRepository = repository;
  if (!underOut(repository, outputRoot)) {
    assert.equal(outputRoot, path.join(qualification.build.buildRoot, 'components/firLightTreePsiViewsReceipt'),
      'Only the exact qualified historical PSI output owner is permitted');
    verifierRepository = qualification.build.snapshotRoot;
    assert.equal(qualification.build.buildRoot, path.join(verifierRepository, 'out', path.basename(qualification.build.buildRoot)));
  }
  const currentLockBytes = await readRegular(path.join(psiHere, 'sources.lock.json'));
  checked(currentLockBytes, qualification.sourceLock, 'Qualified PSI source lock changed');
  assert.equal(sha256(currentLockBytes), psiSourceLockSha256, 'Tower predecessor PSI recipe changed');
  const verifierHere = path.join(verifierRepository, psiRelative);
  assert.deepEqual(await readRegular(path.join(verifierHere, 'sources.lock.json')), currentLockBytes);
  const psiLock = JSON.parse(currentLockBytes);
  // Authenticate code, imports and source locks before dynamic import. No
  // caller-specified module or arbitrary external repository is executable.
  for (const pin of psiLock.dependencies) verifyFile(await readRegular(path.resolve(verifierHere, pin.path)), pin);
  const receiptPath = path.join(outputRoot, 'receipt.json'), bytes = await readRegular(receiptPath, 32 * 1024 * 1024);
  assert.equal(sha256(bytes), expectedReceiptSha256, 'Previous PSI receipt changed');
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.kind, 'sealed-lighttree-fir-psi-view-preparation');
  assert.equal(receipt.sourceRoot, sourceRoot); assert.equal(receipt.sourceLockSha256, psiSourceLockSha256);
  assert.deepEqual(receipt.source, psiLock.source);
  assert.deepEqual(receipt.addedSources, []); assert.deepEqual(receipt.sourceSetExclusions, []);
  const replacements = new Map(receipt.files.map(row => [row.before.path, row.after]));
  const predecessor = receipt.selection.sources.map(row => structuredClone(replacements.get(row.path) ?? row));
  assert.deepEqual(retainedSources, predecessor, 'Tower predecessor must be the complete actual PSI output graph');
  const previous = await import(pathToFileURL(path.join(verifierHere, 'prepare.mjs')));
  const final = await previous.verifyFirLightTreePsiViewFinalSources({ sourceRoot, outputRoot, expectedReceiptSha256,
    retainedSources, recordedPropertyImports });
  return { profile: { sourceRoot, outputRoot, expectedReceiptSha256, receiptPath,
    sourceLockSha256: psiSourceLockSha256, buildRoot: path.resolve(outputRoot, '../..'), verifierRepository },
  finalReceipt: final.receipt };
}

export async function inspectTowerModeMapSelection(rows, input, { phase, outputRoot, priorBuildRoot }) {
  assert(['before', 'after'].includes(phase));
  assert(Array.isArray(rows)); assert.equal(rows.length, input.selected.rows.length, 'Complete 3571-source tower selection required');
  const paths = new Set(), owners = new Set();
  // Check every field and ordered owner before opening any selected source.
  for (const [index, row] of rows.entries()) {
    const baseline = input.selected.rows[index];
    assert.deepEqual(Object.keys(row), rowKeys, 'Complete tower row metadata and key order required');
    assert.equal(row.compile, true, 'Inactive tower compiler input'); relativePath(row.path);
    assert.equal(row.path, baseline.path, 'Actual tower source selection or order changed');
    assert(!paths.has(row.path) && !owners.has(row.filename), 'Duplicate tower logical source or owner');
    paths.add(row.path); owners.add(row.filename);
    const changed = phase === 'after' && row.path === TARGET;
    const expectedOwner = changed ? path.join(outputRoot, row.path) : path.join(priorBuildRoot, baseline.ownerRelative);
    assert.equal(row.filename, expectedOwner, 'Noncanonical tower source owner: ' + row.path);
    const expected = changed ? input.lock.assembledOutput : baseline;
    assert.deepEqual({ bytes: row.bytes, sha256: row.sha256 }, { bytes: expected.bytes, sha256: expected.sha256 },
      'Actual tower source body changed: ' + row.path);
  }
  assert.equal(rows.filter(row => row.path.startsWith('compiler-port-jvm-descriptor-signatures/')).length, 18);
  for (let offset = 0; offset < rows.length; offset += 24) {
    const batch = await Promise.allSettled(rows.slice(offset, offset + 24).map(async row => {
      const bytes = checked(await readRegular(row.filename), row, 'Selected tower source bytes changed: ' + row.path);
      if (row.path === TARGET) assert.deepEqual(normalizeImports(bytes, input.lock.recordedPropertyImports),
        phase === 'before' ? input.original : input.transformed, 'Complete private tower map algorithm/import changed');
    }));
    for (const result of batch) if (result.status !== 'fulfilled') throw result.reason;
  }
  return { sources: structuredClone(rows), jvmSignatureSources: 18, replacedPaths: phase === 'after' ? TARGETS : [],
    scope: 'Complete ordered selected files, owners, metadata and bytes; private map specialization only' };
}

function receiptFor(input, sourceRoot, selected, previousPsi, files) {
  return { schemaVersion: 1, kind: 'fir-private-tower-mode-map-preparation', source: input.lock.source,
    sourceRoot, sourceLockSha256: sha256(input.lockBytes), baselineSelectionSha256: input.lock.selection.sha256,
    previousPsi: previousPsi.profile, previousPsiFinalReceipt: previousPsi.finalReceipt,
    selection: selected, files, replacedOriginalPaths: TARGETS, sourceSetExclusions: [], addedSources: [], modes: MODES,
    nullableValuesPreserved: true, copyAndSharingPreserved: true, sameModeReturnThisPreserved: true,
    constructorScopesPreserved: true, companionBlockRegularOnlyPreserved: true, mapPrivateAndUnenumerated: true,
    fullFirToIrWasmExecuted: false, fullCompilerBuilt: false, publicLanguageSupport: false };
}

export async function prepareFirTowerModeMap({ sourceRoot, outputRoot, retainedSources, preparedPsiViewsProfile, recordedPropertyImports }) {
  sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); outputOwner(outputRoot);
  await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
  assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep));
  const input = await inputs(sourceRoot); assert.deepEqual(recordedPropertyImports, input.lock.recordedPropertyImports);
  assert(preparedPsiViewsProfile); assert.equal(preparedPsiViewsProfile.sourceRoot, sourceRoot);
  const priorBuildRoot = path.resolve(preparedPsiViewsProfile.outputRoot, '../..');
  const selected = await inspectTowerModeMapSelection(retainedSources, input, { phase: 'before', outputRoot, priorBuildRoot });
  const previousPsi = await verifyPsiPredecessor({ ...preparedPsiViewsProfile, retainedSources: selected.sources,
    recordedPropertyImports, psiSourceLockSha256: input.lock.psiSourceLockSha256 });
  async function put(logical, bytes) {
    const filename = path.join(outputRoot, logical); await assertNoSymlink(filename);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename;
  }
  const before = selected.sources.find(row => row.path === TARGET), predecessor = await readRegular(before.filename);
  await put('original/' + TARGET, input.original); await put('predecessor/' + TARGET, predecessor);
  const transformed = transformTowerModeMap(TARGET, predecessor);
  assert.deepEqual(transformTowerModeMap(TARGET, transformed, { reverse: true }), predecessor);
  checked(transformed, input.lock.assembledOutput, 'Assembled tower output changed');
  const filename = await put(TARGET, transformed), after = { ...before, filename, ...identity(transformed) };
  const receipt = receiptFor(input, sourceRoot, selected, previousPsi, [{ before, after }]), receiptPath = path.join(outputRoot, 'receipt.json');
  await writeJson(receiptPath, receipt);
  return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath, 32 * 1024 * 1024)),
    commonSources: [filename], replacedOriginalPaths: TARGETS, sourceSetExclusions: [] };
}

export async function verifyFirTowerModeMapFinalSources({ sourceRoot, outputRoot, retainedSources, expectedReceiptSha256, recordedPropertyImports }) {
  sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); outputOwner(outputRoot);
  assert.match(expectedReceiptSha256 ?? '', /^[a-f0-9]{64}$/);
  const input = await inputs(sourceRoot); assert.deepEqual(recordedPropertyImports, input.lock.recordedPropertyImports);
  const bytes = await readRegular(path.join(outputRoot, 'receipt.json'), 32 * 1024 * 1024);
  assert.equal(sha256(bytes), expectedReceiptSha256, 'Tower preparation receipt changed');
  const receipt = JSON.parse(bytes), priorBuildRoot = path.resolve(receipt.previousPsi.outputRoot, '../..');
  const selected = await inspectTowerModeMapSelection(retainedSources, input, { phase: 'after', outputRoot, priorBuildRoot });
  const prior = await inspectTowerModeMapSelection(receipt.selection.sources, input, { phase: 'before', outputRoot, priorBuildRoot });
  const before = prior.sources.find(row => row.path === TARGET), filename = path.join(outputRoot, TARGET);
  assert.deepEqual(await readRegular(path.join(outputRoot, 'original', TARGET)), input.original);
  const predecessor = checked(await readRegular(path.join(outputRoot, 'predecessor', TARGET)), before, 'Tower predecessor snapshot changed');
  const actual = await readRegular(filename);
  assert.deepEqual(transformTowerModeMap(TARGET, actual, { reverse: true }), predecessor, 'Complete tower predecessor inverse changed');
  const after = { ...before, filename, ...identity(actual) }, files = [{ before, after }];
  assert.deepEqual(selected.sources, prior.sources.map(row => row.path === TARGET ? after : row),
    'Tower graph changed outside the single exact replacement');
  const predecessorRetainedSources = selected.sources.map(row => structuredClone(row.path === TARGET ? before : row));
  assert.deepEqual(predecessorRetainedSources, prior.sources, 'Complete tower predecessor metadata/order changed');
  for (const [index, row] of predecessorRetainedSources.entries()) assert.deepEqual(Object.keys(row), Object.keys(prior.sources[index]));
  // Pass the entire reconstructed predecessor vector. The old PSI guard never
  // receives the newly transformed tower row and its hash guards stay unchanged.
  const previousPsi = await verifyPsiPredecessor({ ...receipt.previousPsi, retainedSources: predecessorRetainedSources,
    recordedPropertyImports, psiSourceLockSha256: input.lock.psiSourceLockSha256 });
  assert.deepEqual(receipt, receiptFor(input, sourceRoot, prior, previousPsi, files));
  return { receipt: { schemaVersion: 1, kind: 'fir-private-tower-mode-map-final', sourceLockSha256: sha256(input.lockBytes),
    preparationReceiptSha256: expectedReceiptSha256, actualSelectedSources: selected.sources.length,
    actualSelectionSha256: sha256(Buffer.from(JSON.stringify(selected.sources))), predecessorSelectedSources: prior.sources.length,
    files, modes: MODES, jvmSignatureSources: 18, previousPsiFinalReceipt: previousPsi.finalReceipt,
    completeOneRowMetadataAndOrderPreserved: true, previousPsiDeltaPreserved: true, noSourcesAddedOrExcluded: true,
    nullableValuesPreserved: true, copyAndSharingPreserved: true, sameModeReturnThisPreserved: true,
    constructorScopesPreserved: true, companionBlockRegularOnlyPreserved: true, mapPrivateAndUnenumerated: true,
    fullFirToIrWasmExecuted: false, fullCompilerBuilt: false, publicLanguageSupport: false }, predecessorRetainedSources };
}
