import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { CONTEXT, PATHS, REPLACEMENTS, transformWasmCollections } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');

export async function verifyWasmCollectionsInputs({ sourceRoot, preparedIdentity, preparedText }) {
    sourceRoot = path.resolve(sourceRoot); await assertNoSymlink(sourceRoot);
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
    assert.equal(lock.kind, 'selected-wasm-serial-collections-common-boundary');
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    assert.deepEqual(lock.sources.map(pin => pin.path), PATHS);
    assert.deepEqual(lock.replacements, REPLACEMENTS);
    assert.equal(sha256(await readRegular(path.join(here, 'transform.mjs'))), lock.transformSha256);
    const original = new Map();
    for (const pin of lock.sources) original.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, relativePath(pin.path))), pin));
    const variants = new Map([[CONTEXT, original.get(CONTEXT)]]); const predecessorBindings = [];
    for (const [key, component] of [['identityReceipt', preparedIdentity], ['textReceipt', preparedText]]) {
        assert(component?.receiptPath && component.commonSources && component.receipt, 'Genuine prepared predecessor required: ' + key);
        const dependency = lock.predecessors.find(item => item.component === key); assert(dependency);
        const parentLock = await readRegular(path.join(here, dependency.sourceLockPath));
        assert.equal(sha256(parentLock), dependency.sourceLockSha256, 'Predecessor lock changed: ' + key);
        assert.equal(sha256(await readRegular(path.join(here, dependency.prepareToolPath))), dependency.prepareToolSha256, 'Predecessor tool changed: ' + key);
        const receipt = JSON.parse(await readRegular(component.receiptPath));
        assert.deepEqual(receipt, component.receipt, 'Predecessor receipt object differs from disk');
        assert.equal(receipt.sourceLockSha256, dependency.sourceLockSha256);
        assert.equal(receipt.preparationToolSha256, dependency.prepareToolSha256);
        assert.deepEqual(receipt.source, lock.source);
        const pin = dependency.variant;
        const declared = receipt.files.find(item => item.path === pin.path); assert(declared);
        assert.equal(declared.bytes, pin.bytes); assert.equal(declared.sha256, pin.sha256);
        const matches = component.commonSources.filter(filename => filename.endsWith('/' + pin.path));
        assert.equal(matches.length, 1, 'Selected predecessor must occur exactly once');
        const filename = path.resolve(matches[0]); await assertNoSymlink(filename);
        const bytes = await readRegular(filename); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Changed prepared predecessor bytes');
        assert.equal(declared.originalSha256, lock.sources.find(item => item.path === pin.path).sha256);
        variants.set(pin.path, bytes);
        predecessorBindings.push({ component: key, logicalPath: pin.path, componentRelativePath: dependency.componentRelativePath, filename, bytes: bytes.length, sha256: pin.sha256,
            receiptSha256: sha256(await readRegular(component.receiptPath)), sourceLockSha256: dependency.sourceLockSha256, preparationToolSha256: dependency.prepareToolSha256 });
    }
    return { sourceRoot, lockBytes, lock, original, variants, predecessorBindings };
}

export async function prepareWasmCollectionsSources({ sourceRoot, outputRoot, preparedIdentity, preparedText }) {
    const input = await verifyWasmCollectionsInputs({ sourceRoot, preparedIdentity, preparedText });
    outputRoot = path.resolve(outputRoot); assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    assert(outputRoot !== input.sourceRoot && !outputRoot.startsWith(input.sourceRoot + path.sep) && !input.sourceRoot.startsWith(outputRoot + path.sep));
    await assertNoSymlink(outputRoot); await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const commonSources = [], files = [];
    for (const pin of input.lock.sources) {
        const bytes = transformWasmCollections(pin.path, input.variants.get(pin.path));
        assert.equal(bytes.length, pin.preparedBytes); assert.equal(sha256(bytes), pin.preparedSha256, 'Transformed Wasm collections bytes changed');
        const filename = path.join(outputRoot, relativePath(pin.path)); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        commonSources.push(filename); files.push({ path: pin.path, bytes: bytes.length, sha256: sha256(bytes), originalSha256: pin.sha256,
            predecessorSha256: sha256(input.variants.get(pin.path)) });
    }
    const receipt = { schemaVersion: 1, kind: 'selected-wasm-serial-collections-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
        transformSha256: input.lock.transformSha256, originals: input.lock.sources, predecessorBindings: input.predecessorBindings,
        files, replacedOriginalPaths: PATHS, replacements: REPLACEMENTS, hostProfile: 'one serial compiler Worker; selected maps have nonnull values and no same-map callback writes',
        retainedPredecessorChanges: true, originalSourceUnmodified: true, genericJvmShim: false, fullCompilerBuilt: false, publicLanguageSupport: false };
    const receiptPath = path.join(outputRoot, 'wasm-collections-inputs.json'); await writeJson(receiptPath, receipt);
    return { commonSources, replacedOriginalPaths: PATHS, predecessorBindings: input.predecessorBindings, receipt, receiptPath };
}
