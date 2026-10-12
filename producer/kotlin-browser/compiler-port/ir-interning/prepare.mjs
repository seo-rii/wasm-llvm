import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { TARGET, INTERNING_SET, RECIPE, transformIrInterning, normalizeIrInterningImports } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
async function load(sourceRoot) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(lock.kind, 'genuine-ir-interning-common-host'); assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.primaryClosureSha256, sha256(closureBytes)); assert.deepEqual(lock.source, closure.source);
    assert.deepEqual(lock.original, closure.files.find(pin => pin.path === TARGET)); assert.deepEqual(lock.recipe, RECIPE);
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    for (const pin of lock.callerAndDependencySources) {
        assert.deepEqual(pin, closure.files.find(row => row.path === pin.path));
        verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin);
    }
    const original = verifyFile(await readRegular(path.join(sourceRoot, TARGET)), lock.original);
    const common = verifyFile(transformIrInterning(original), lock.output);
    const interningSet = verifyFile(await readRegular(path.join(HERE, 'CanonicalInterningSet.kt')), lock.interningSet);
    assert.equal(lock.output.path, TARGET); assert.equal(lock.interningSet.outputPath, INTERNING_SET);
    return { lock, lockBytes, original, common, interningSet };
}
function roots(sourceRoot, outputRoot) {
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep), 'Interning output must be under out/');
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Interning input/output overlap');
}
async function receiptFor(input) {
    return { schemaVersion: 1, kind: 'genuine-ir-interning-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
        original: input.lock.original, callerAndDependencySources: input.lock.callerAndDependencySources, files: [input.lock.output, { ...input.lock.interningSet, path: INTERNING_SET }], recipe: RECIPE,
        originalAlgorithmsRetained: true, lazyCachesRetained: 3,
        interningSetContract: 'Canonical addOrGet/clear only; equality/hash strategy, first instance identity, open addressing and null-equivalent bucket.',
        fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareIrInterning({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); roots(sourceRoot, outputRoot);
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const input = await load(sourceRoot), receipt = await receiptFor(input), commonSources = [];
    for (const [pin, bytes] of [[receipt.files[0], input.common], [receipt.files[1], input.interningSet]]) {
        const filename = path.join(outputRoot, relativePath(pin.path)); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); commonSources.push(filename);
    }
    const reference = path.join(outputRoot, 'reference-original', TARGET);
    await mkdir(path.dirname(reference), { recursive: true, mode: 0o700 }); await writeFile(reference, input.original, { flag: 'wx', mode: 0o600 });
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath)), commonSources, replacedOriginalPaths: [TARGET] };
}
async function replay({ sourceRoot, outputRoot, expectedReceiptSha256 }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); roots(sourceRoot, outputRoot);
    const input = await load(sourceRoot), receipt = await receiptFor(input), bytes = await readRegular(path.join(outputRoot, 'receipt.json'));
    assert.equal(sha256(bytes), expectedReceiptSha256, 'Interning receipt digest changed');
    assert.deepEqual(JSON.parse(bytes), receipt, 'Interning receipt changed');
    assert.deepEqual(await readRegular(path.join(outputRoot, 'reference-original', TARGET)), input.original, 'Interning full original snapshot changed');
    return { input, receipt, outputRoot };
}
export async function verifyIrInterning(options) {
    const replayed = await replay(options);
    for (const pin of replayed.receipt.files) verifyFile(await readRegular(path.join(replayed.outputRoot, pin.path)), pin);
    return replayed.receipt;
}
export async function verifyFinalIrInterning({ retainedSources, recordedPropertyImports = [], ...options }) {
    const { input, receipt, outputRoot } = await replay(options);
    assert(Array.isArray(retainedSources) && retainedSources.length, 'Interning actual final selection required');
    const paths = new Set(), filenames = new Set(), checked = [];
    for (const row of retainedSources) {
        relativePath(row.path); assert(!paths.has(row.path), 'Duplicate interning final logical path'); paths.add(row.path);
        assert(path.isAbsolute(row.filename) && !filenames.has(row.filename), 'Duplicate interning final owner'); filenames.add(row.filename);
        const pin = receipt.files.find(item => item.path === row.path); if (!pin) continue;
        assert.equal(row.filename, path.join(outputRoot, pin.path), 'Wrong interning final owner');
        const bytes = await readRegular(row.filename); assert.equal(bytes.length, row.bytes); assert.equal(sha256(bytes), row.sha256, 'Interning final source hash changed');
        const canonical = pin.path === TARGET ? input.common : input.interningSet;
        verifyFile(normalizeIrInterningImports(bytes, canonical, recordedPropertyImports), pin);
        checked.push({ path: row.path, filename: row.filename, bytes: row.bytes, sha256: row.sha256 });
    }
    assert.equal(checked.length, receipt.files.length, 'Missing interning final source');
    return { schemaVersion: 1, kind: 'genuine-ir-interning-final', sourceLockSha256: sha256(input.lockBytes),
        receiptSha256: options.expectedReceiptSha256, checked, exactBodyAndOwnerVerified: true, fullCompilerBuilt: false, languageReadiness: false };
}
