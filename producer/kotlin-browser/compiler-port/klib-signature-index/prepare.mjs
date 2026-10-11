import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { INDEX, MEMORY, SIGNATURE, applyExact, indexChanges, memoryChanges, normalizeImports } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
function outputPath(outputRoot) {
    assert(path.isAbsolute(outputRoot) && outputRoot.startsWith(path.join(REPO, 'out') + path.sep), 'Signature index output must stay under out/');
    return outputRoot;
}
async function inputs(sourceRoot) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'genuine-memory-klib-signature-index');
    const primaryBytes = await readRegular(path.join(HERE, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
    assert.equal(sha256(primaryBytes), lock.primaryClosureSha256); assert.deepEqual(lock.source, primary.source);
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    const originals = new Map();
    for (const pin of lock.originals) {
        assert.deepEqual(pin, primary.files.find(row => row.path === pin.path));
        originals.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, relativePath(pin.path))), pin));
    }
    assert.deepEqual([...originals.keys()], [INDEX, SIGNATURE]);
    const memory = verifyFile(await readRegular(path.join(HERE, '../klib/MemoryKotlinLibrary.kt')), lock.predecessor);
    const index = applyExact(originals.get(INDEX), indexChanges), library = applyExact(memory, memoryChanges);
    assert.deepEqual(applyExact(index, indexChanges, true), originals.get(INDEX), 'Index recipe is not reversible');
    assert.deepEqual(applyExact(library, memoryChanges, true), memory, 'Library recipe is not reversible');
    const typeNames = verifyFile(await readRegular(path.join(HERE, 'SignatureIndexTypeName.kt')), lock.helper);
    const files = [index, library, typeNames];
    for (const [i, pin] of lock.outputs.entries()) verifyFile(files[i], pin);
    assert.deepEqual(lock.outputs.map(row => row.path), [INDEX, MEMORY, lock.helper.outputPath]);
    return { lock, lockBytes, originals, memory, files };
}
async function bindPredecessor(i, component, retainedSources) {
    assert(component && Array.isArray(component.commonSources) && Array.isArray(retainedSources), 'Actual KLIB predecessor selection is required');
    const receiptPath = path.resolve(component.receiptPath), directory = path.dirname(receiptPath);
    assert.equal(path.basename(receiptPath), 'klib-receipt.json'); assert.equal(path.basename(directory), 'compiler-port-klib'); outputPath(directory);
    const filename = path.join(directory, 'MemoryKotlinLibrary.kt');
    const receiptBytes = await readRegular(receiptPath), previous = JSON.parse(receiptBytes);
    assert.deepEqual(previous, component.receipt, 'KLIB predecessor receipt object differs');
    assert.equal(previous.kind, 'official-klib-portable-host-preparation'); assert.equal(previous.source.commit, i.lock.source.commit);
    assert.equal(previous.sourceLockSha256, i.lock.dependencies.find(row => row.path === '../klib/sources.lock.json').sha256);
    assert.deepEqual(previous.sources.filter(row => row.path === MEMORY), [{ path: MEMORY, bytes: i.memory.length, sha256: sha256(i.memory), originalSha256: null }]);
    assert.equal(component.commonSources.filter(value => value === filename).length, 1, 'KLIB predecessor owner must be unique');
    assert.equal(retainedSources.filter(value => value.filename === filename).length, 1, 'KLIB predecessor filename must be unique');
    const selected = retainedSources.filter(row => row.path === MEMORY); assert.equal(selected.length, 1);
    assert.deepEqual(selected[0], { path: MEMORY, filename, bytes: i.memory.length, sha256: sha256(i.memory) }, 'Wrong selected KLIB predecessor');
    verifyFile(await readRegular(filename), i.lock.predecessor);
    return { component: 'klibReceipt', componentRelativePath: MEMORY, filename, bytes: i.memory.length, sha256: sha256(i.memory), receiptPath, receiptSha256: sha256(receiptBytes) };
}
async function replayPredecessor(i, binding) {
    assert.equal(binding.component, 'klibReceipt'); assert.equal(binding.componentRelativePath, MEMORY);
    const filename = path.join(path.dirname(binding.receiptPath), 'MemoryKotlinLibrary.kt'); assert.equal(binding.filename, filename);
    const bytes = await readRegular(binding.receiptPath); assert.equal(sha256(bytes), binding.receiptSha256, 'KLIB predecessor receipt changed');
    const previous = JSON.parse(bytes);
    const rebound = await bindPredecessor(i, { receiptPath: binding.receiptPath, receipt: previous, commonSources: [filename] }, [{ path: MEMORY, filename, bytes: binding.bytes, sha256: binding.sha256 }]);
    assert.deepEqual(rebound, binding); return binding;
}
function receiptFor(i, binding) {
    return { schemaVersion: 1, kind: 'genuine-memory-klib-signature-index-preparation', source: i.lock.source,
        sourceLockSha256: sha256(i.lockBytes), originals: i.lock.originals, files: i.lock.outputs, predecessorBinding: binding,
        indexHostSpans: indexChanges.length, memoryComponentSpans: memoryChanges.length,
        completeSignatureIndexAlgorithms: true, verifiedMemoryInput: true, boundedMemoryOutput: true,
        lazyComponentIdentity: true, exactSealedSubtypeDiagnosticNames: true, noNewSourceExclusions: true,
        fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareKlibSignatureIndex({ sourceRoot, outputRoot, klibComponent, retainedSources }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = outputPath(path.resolve(outputRoot));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Signature index roots overlap');
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const i = await inputs(sourceRoot), binding = await bindPredecessor(i, klibComponent, retainedSources), receipt = receiptFor(i, binding), commonSources = [];
    const selected = retainedSources.filter(row => row.path === INDEX); assert.equal(selected.length, 1, 'One actual index source is required');
    const original = i.originals.get(INDEX); assert.equal(selected[0].bytes, original.length); assert.equal(selected[0].sha256, sha256(original));
    assert.deepEqual(await readRegular(selected[0].filename), original, 'Unexpected index predecessor body');
    for (const [logical, bytes] of [...i.originals, ...receipt.files.map((pin, n) => [pin.path, i.files[n]])]) {
        const reference = i.originals.get(logical) === bytes;
        const filename = path.join(outputRoot, reference ? 'reference' : '', relativePath(logical)); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        if (!reference) commonSources.push(filename);
    }
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, commonSources, predecessorBindings: [binding], replacedOriginalPaths: [INDEX, MEMORY] };
}
export async function verifyKlibSignatureIndex(outputRoot) {
    outputRoot = outputPath(path.resolve(outputRoot)); await assertNoSymlink(outputRoot);
    const i = await inputs(path.join(outputRoot, 'reference')), stored = JSON.parse(await readRegular(path.join(outputRoot, 'receipt.json')));
    const receipt = receiptFor(i, await replayPredecessor(i, stored.predecessorBinding)); assert.deepEqual(stored, receipt, 'Signature index receipt changed');
    for (const pin of receipt.files) verifyFile(await readRegular(path.join(outputRoot, pin.path)), pin);
    return receipt;
}
export async function verifyFinalKlibSignatureIndex({ outputRoot, retainedSources, recordedPropertyImports = [] }) {
    outputRoot = outputPath(path.resolve(outputRoot)); await assertNoSymlink(outputRoot);
    const i = await inputs(path.join(outputRoot, 'reference')), stored = JSON.parse(await readRegular(path.join(outputRoot, 'receipt.json')));
    const receipt = receiptFor(i, await replayPredecessor(i, stored.predecessorBinding)); assert.deepEqual(stored, receipt, 'Signature index receipt changed');
    assert(Array.isArray(retainedSources) && retainedSources.length > 0);
    const paths = new Set(), filenames = new Set(), checked = [], predecessorRetainedSources = [];
    for (const item of retainedSources) {
        relativePath(item.path); assert(!paths.has(item.path), 'Duplicate signature index selection path'); paths.add(item.path);
        assert(path.isAbsolute(item.filename) && !filenames.has(item.filename), 'Duplicate signature index selection filename'); filenames.add(item.filename);
        const pin = receipt.files.find(row => row.path === item.path);
        if (!pin) { predecessorRetainedSources.push(item); continue; }
        assert.equal(item.filename, path.join(outputRoot, pin.path), 'Wrong signature index final owner');
        const bytes = await readRegular(item.filename); assert.equal(bytes.length, item.bytes); assert.equal(sha256(bytes), item.sha256);
        verifyFile(normalizeImports(bytes, recordedPropertyImports), pin); checked.push(item);
        if (item.path === MEMORY) {
            const previous = receipt.predecessorBinding;
            predecessorRetainedSources.push({ path: MEMORY, filename: previous.filename, bytes: previous.bytes, sha256: previous.sha256 });
        } else predecessorRetainedSources.push(item);
    }
    assert.equal(checked.length, receipt.files.length, 'Missing final signature index source');
    return { receipt: { schemaVersion: 1, kind: 'genuine-memory-klib-signature-index-final', sourceLockSha256: sha256(i.lockBytes), checked,
        exactBodyAndImportsVerified: true, completeSignatureIndexAlgorithms: true, fullCompilerBuilt: false, languageReadiness: false }, predecessorRetainedSources };
}
