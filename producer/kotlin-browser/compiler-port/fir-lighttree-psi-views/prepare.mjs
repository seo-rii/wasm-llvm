import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { normalizeImports } from '../klib-signature-index/transform.mjs';
import { transform, exceptionChanges } from '../compiler-exception-attachment-profile/transform.mjs';
import { lexicalReferenceView } from '../native-js-output-profile/references.mjs';
import { TARGETS, UTILS, HOST, LINES, ELEMENT, RECIPE, transformPsiViews } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const checked = (bytes, pin, message) => { assert.deepEqual(identity(bytes), { bytes: pin.bytes, sha256: pin.sha256 }, message); return bytes; };
const rowKeys = ['path', 'filename', 'bytes', 'sha256', 'compile'];

function outputOwner(root) {
  assert(path.isAbsolute(root) && root === path.resolve(root) && root.startsWith(path.join(repository, 'out') + path.sep),
    'LightTree PSI output must have a canonical owner under out/');
}

async function inputs(sourceRoot) {
  const lockBytes = await readRegular(path.join(here, 'sources.lock.json'));
  const lock = JSON.parse(lockBytes), primaryBytes = await readRegular(path.join(here, '../closure.lock.json'));
  const primary = JSON.parse(primaryBytes);
  assert.equal(lock.kind, 'sealed-lighttree-fir-psi-views'); assert.equal(lock.schemaVersion, 1);
  assert.deepEqual(lock.source, primary.source); assert.equal(lock.primaryClosureSha256, sha256(primaryBytes));
  assert.deepEqual(lock.targets.map(row => row.path), TARGETS); assert.deepEqual(lock.recipes, RECIPE);
  for (const pin of lock.dependencies) verifyFile(await readRegular(path.resolve(here, pin.path)), pin);
  const selected = JSON.parse(verifyFile(await readRegular(path.join(here, 'selection.lock.json'), 8 * 1024 * 1024), lock.selection));
  assert.equal(selected.kind, 'actual-current-foundation-fir-psi-selection');
  assert.equal(selected.rows.length, 3571); assert.equal(selected.compilerExitCode, 1);
  assert.equal(selected.currentFoundationQualified, true);
  assert.deepEqual(selected.source, lock.source);
  const originals = new Map(), incoming = new Map(), outgoing = new Map();
  for (const pin of lock.targets) {
    assert.deepEqual(pin, primary.files.find(row => row.path === pin.path));
    const original = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin);
    const before = pin.path === UTILS ? transform(original, exceptionChanges(pin.path, original)) : original;
    const after = transformPsiViews(pin.path, before);
    checked(before, lock.incoming.find(row => row.path === pin.path), 'Complete PSI predecessor algorithm changed');
    checked(after, lock.outgoing.find(row => row.path === pin.path), 'Complete LightTree PSI output changed');
    assert.deepEqual(transformPsiViews(pin.path, after, { reverse: true }), before);
    originals.set(pin.path, original); incoming.set(pin.path, before); outgoing.set(pin.path, after);
  }
  return { lock, lockBytes, selected, originals, incoming, outgoing };
}

async function bindException(prepared, rows, input) {
  assert(prepared && path.isAbsolute(prepared.outputRoot));
  assert.equal(prepared.outputRoot, path.resolve(prepared.outputRoot));
  assert.equal(path.basename(prepared.outputRoot), 'compilerExceptionAttachmentReceipt');
  assert.match(prepared.expectedReceiptSha256 ?? '', /^[a-f0-9]{64}$/);
  const filename = path.join(prepared.outputRoot, 'receipt.json'), bytes = await readRegular(filename, 64 * 1024 * 1024);
  assert.equal(sha256(bytes), prepared.expectedReceiptSha256, 'Previous exception receipt changed');
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.kind, 'official-compiler-exception-attachment-preparation');
  assert.equal(receipt.sourceLockSha256, input.lock.exceptionSourceLockSha256);
  assert.deepEqual(receipt.source, input.lock.source);
  assert.equal(receipt.files.length, 6); assert.equal(receipt.excluded.length, 2); assert.equal(receipt.helpers.length, 2);
  const replacements = new Map(receipt.files.map(row => [row.before.path, row.after]));
  const current = receipt.selection.sources.filter(row => !receipt.sourceSetExclusions.includes(row.path))
    .map(row => replacements.get(row.path) ?? row);
  current.push(...receipt.helpers);
  assert.deepEqual(current, rows, 'PSI predecessor must be the complete actual exception output graph');
  assert.equal(rows.find(row => row.path === UTILS).filename, path.join(prepared.outputRoot, UTILS));
  return { outputRoot: prepared.outputRoot, receiptPath: filename, expectedReceiptSha256: prepared.expectedReceiptSha256,
    sourceRoot: receipt.sourceRoot, sourceLockSha256: receipt.sourceLockSha256,
    buildRoot: path.resolve(prepared.outputRoot, '../..') };
}

export async function inspectPsiViewSelection(rows, input, { phase, outputRoot, priorBuildRoot }) {
  assert(['before', 'after'].includes(phase));
  assert(Array.isArray(rows)); assert.equal(rows.length, input.selected.rows.length, 'Complete 3571-source PSI selection required');
  const seen = new Set(), owners = new Set(), sources = [], views = [], canonical = new Map();
  for (let offset = 0; offset < rows.length; offset += 24) {
    const batch = await Promise.allSettled(rows.slice(offset, offset + 24).map(async row => ({ row, bytes: await readRegular(row.filename) })));
    for (const result of batch) {
      if (result.status !== 'fulfilled') throw result.reason;
      const { row, bytes } = result.value, index = sources.length, baseline = input.selected.rows[index];
      assert.deepEqual(Object.keys(row), rowKeys, 'Complete PSI row metadata and key order required');
      assert.equal(row.compile, true, 'Inactive PSI compiler input'); relativePath(row.path);
      assert.equal(row.path, baseline.path, 'Actual PSI source selection or order changed');
      assert(!seen.has(row.path) && !owners.has(row.filename), 'Duplicate PSI logical source or owner');
      seen.add(row.path); owners.add(row.filename);
      const target = TARGETS.includes(row.path);
      const expectedOwner = phase === 'after' && target ? path.join(outputRoot, row.path) : path.join(priorBuildRoot, baseline.ownerRelative);
      assert.equal(row.filename, expectedOwner, 'Noncanonical PSI source owner: ' + row.path);
      checked(bytes, row, 'Selected PSI source bytes changed: ' + row.path);
      const expected = phase === 'after' && target ? input.lock.assembledOutputs.find(pin => pin.path === row.path) : baseline;
      checked(bytes, expected, 'Actual PSI source body changed: ' + row.path);
      const normalized = normalizeImports(bytes, input.lock.recordedPropertyImports);
      if (target) assert.deepEqual(normalized, (phase === 'before' ? input.incoming : input.outgoing).get(row.path),
        'Complete PSI algorithm/import changed: ' + row.path);
      if ([HOST, LINES, ELEMENT, ...input.lock.portableBindings.map(pin => pin.path)].includes(row.path)) canonical.set(row.path, normalized);
      const view = lexicalReferenceView(bytes.toString());
      const names = ['psi', 'realPsi', 'MetadataSource', 'isCompiledElement', 'sourceFileLinesMapping', 'KtPsiSourceFileLinesMapping']
        .filter(name => new RegExp('\\b' + name + '\\b').test(view));
      if (names.length) views.push({ path: row.path, names });
      sources.push(structuredClone(row));
    }
  }
  const host = canonical.get(HOST)?.toString();
  assert(host?.includes('sealed class KtSourceElement : AbstractKtSourceElement()'));
  assert.equal([...host.matchAll(/: KtSourceElement\(/g)].length, 1);
  assert(host.includes('class KtLightSourceElement('));
  assert(!/\b(?:class|object|interface)\s+Kt\w*PsiSourceElement\b|\bunwrapToKtPsiSourceElement\b/.test(host));
  assert(canonical.get(ELEMENT)?.includes(Buffer.from('val source: KtSourceElement?')));
  const lines = canonical.get(LINES)?.toString();
  assert(lines?.includes('interface KtSourceFileLinesMapping'));
  assert(!/\bclass KtPsiSourceFileLinesMapping\b/.test(lines));
  const portableBindings = [];
  for (const pin of input.lock.portableBindings) {
    checked(canonical.get(pin.path), pin, 'Portable source binding changed: ' + pin.path);
    const receiptPath = path.join(priorBuildRoot, pin.receiptRelative), receiptBytes = await readRegular(receiptPath);
    const receipt = JSON.parse(receiptBytes);
    assert.equal(receipt.sourceLockSha256, pin.sourceLockSha256, 'Portable source owner recipe changed');
    const output = receipt[pin.outputField].find(row => row.path === pin.path);
    checked(canonical.get(pin.path), output, 'Portable source owner output differs from selected declaration');
    portableBindings.push({ path: pin.path, owner: rows.find(row => row.path === pin.path),
      canonical: { bytes: pin.bytes, sha256: pin.sha256 }, receiptPath, receiptSha256: sha256(receiptBytes),
      sourceLockSha256: pin.sourceLockSha256 });
  }
  assert.deepEqual(views, input.lock.viewReferences[phase], 'PSI property, source mapping or metadata callers changed');
  return { sources, sourceFamily: { owner: rows.find(row => row.path === HOST), sealed: true,
    onlySourceImplementation: 'KtLightSourceElement', nullableFirSource: true, psiUnwrapAvailable: false },
  portableBindings, views, scope: 'Exact complete source/owner inventory and conservative lexical references; no resolved whole FIR call-graph claim' };
}

function receiptFor(input, sourceRoot, selected, exception, files) {
  return { schemaVersion: 1, kind: 'sealed-lighttree-fir-psi-view-preparation', source: input.lock.source,
    sourceRoot, sourceLockSha256: sha256(input.lockBytes), baselineSelectionSha256: input.lock.selection.sha256,
    previousException: exception, selection: selected, files, replacedOriginalPaths: TARGETS,
    sourceSetExclusions: [], addedSources: [], sourceGetterEvaluationPreserved: true,
    twoOffsetReceiverContractsPreserved: true, nullPredicateInputOnly: true,
    lineMappingPathAndOriginFallbackPreserved: true, metadataValueAlgorithmsPreserved: true,
    fullFirToIrWasmExecuted: false, fullCompilerBuilt: false, publicLanguageSupport: false };
}

export async function prepareFirLightTreePsiViews({ sourceRoot, outputRoot, retainedSources, preparedExceptionProfile, recordedPropertyImports }) {
  sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); outputOwner(outputRoot);
  await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
  assert(!sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep) && sourceRoot !== outputRoot);
  const input = await inputs(sourceRoot); assert.deepEqual(recordedPropertyImports, input.lock.recordedPropertyImports);
  const exception = await bindException(preparedExceptionProfile, retainedSources, input);
  const selected = await inspectPsiViewSelection(retainedSources, input, { phase: 'before', outputRoot, priorBuildRoot: exception.buildRoot });
  const files = [], commonSources = [];
  async function put(logical, bytes) {
    const filename = path.join(outputRoot, logical); await assertNoSymlink(filename);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename;
  }
  for (const logical of TARGETS) {
    const before = selected.sources.find(row => row.path === logical), bytes = await readRegular(before.filename);
    await put('original/' + logical, input.originals.get(logical));
    await put('predecessor/' + logical, bytes);
    const transformed = transformPsiViews(logical, bytes);
    assert.deepEqual(transformPsiViews(logical, transformed, { reverse: true }), bytes);
    const filename = await put(logical, transformed), after = { ...before, filename, ...identity(transformed) };
    files.push({ before, after }); commonSources.push(filename);
  }
  const receipt = receiptFor(input, sourceRoot, selected, exception, files), receiptPath = path.join(outputRoot, 'receipt.json');
  await writeJson(receiptPath, receipt);
  return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath, 32 * 1024 * 1024)),
    commonSources, replacedOriginalPaths: TARGETS, sourceSetExclusions: [] };
}

export async function verifyFirLightTreePsiViewFinalSources({ sourceRoot, outputRoot, retainedSources, expectedReceiptSha256, recordedPropertyImports }) {
  sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); outputOwner(outputRoot);
  assert.match(expectedReceiptSha256 ?? '', /^[a-f0-9]{64}$/);
  const input = await inputs(sourceRoot); assert.deepEqual(recordedPropertyImports, input.lock.recordedPropertyImports);
  const bytes = await readRegular(path.join(outputRoot, 'receipt.json'), 32 * 1024 * 1024);
  assert.equal(sha256(bytes), expectedReceiptSha256, 'PSI preparation receipt changed');
  const receipt = JSON.parse(bytes);
  const exception = await bindException(receipt.previousException, receipt.selection.sources, input);
  const prior = await inspectPsiViewSelection(receipt.selection.sources, input, { phase: 'before', outputRoot, priorBuildRoot: exception.buildRoot });
  const selected = await inspectPsiViewSelection(retainedSources, input, { phase: 'after', outputRoot, priorBuildRoot: exception.buildRoot });
  const files = [];
  for (const logical of TARGETS) {
    const before = prior.sources.find(row => row.path === logical);
    assert.deepEqual(await readRegular(path.join(outputRoot, 'original', logical)), input.originals.get(logical));
    const predecessor = checked(await readRegular(path.join(outputRoot, 'predecessor', logical)), before, 'PSI predecessor snapshot changed');
    const filename = path.join(outputRoot, logical), actual = await readRegular(filename);
    assert.deepEqual(transformPsiViews(logical, actual, { reverse: true }), predecessor, 'Complete PSI predecessor inverse changed');
    const after = { ...before, filename, ...identity(actual) };
    assert.deepEqual(selected.sources.find(row => row.path === logical), after);
    files.push({ before, after });
  }
  assert.deepEqual(receipt, receiptFor(input, sourceRoot, prior, exception, files));
  const replacements = new Map(files.map(row => [row.before.path, row.after]));
  assert.deepEqual(selected.sources, prior.sources.map(row => replacements.get(row.path) ?? row), 'PSI graph changed outside five exact replacements');
  const reverse = new Map(files.map(row => [row.after.path, row.before]));
  const predecessorRetainedSources = selected.sources.map(row => structuredClone(reverse.get(row.path) ?? row));
  assert.deepEqual(predecessorRetainedSources, prior.sources, 'Complete PSI predecessor metadata/order changed');
  for (const [index, row] of predecessorRetainedSources.entries()) assert.deepEqual(Object.keys(row), Object.keys(prior.sources[index]));
  return { receipt: { schemaVersion: 1, kind: 'sealed-lighttree-fir-psi-view-final',
    sourceLockSha256: sha256(input.lockBytes), preparationReceiptSha256: expectedReceiptSha256,
    actualSelectedSources: selected.sources.length, actualSelectionSha256: sha256(Buffer.from(JSON.stringify(selected.sources))),
    predecessorSelectedSources: prior.sources.length, files, sourceFamily: selected.sourceFamily,
    portableBindings: selected.portableBindings, views: selected.views,
    completeFiveRowMetadataAndOrderPreserved: true, previousExceptionDeltaPreserved: true,
    noSourcesAddedOrExcluded: true, genuineLightTreeNullDomain: true,
    fullFirToIrWasmExecuted: false, fullCompilerBuilt: false, publicLanguageSupport: false }, predecessorRetainedSources };
}
