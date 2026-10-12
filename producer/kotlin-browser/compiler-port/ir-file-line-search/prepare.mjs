import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { normalizeTowerImports } from '../tower-group/transform.mjs';
import { TARGET, RECIPE, transformIrFileLineSearch } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
function roots(sourceRoot, outputRoot) {
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep), 'IR line search output must be under out/');
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'IR line search input/output overlap');
}
async function load(sourceRoot) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'genuine-ir-file-line-search');
    assert.equal(lock.primaryClosureSha256, sha256(closureBytes)); assert.deepEqual(lock.source, closure.source);
    assert.deepEqual(lock.original, closure.files.find(pin => pin.path === TARGET)); assert.deepEqual(lock.recipe, RECIPE);
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    const original = verifyFile(await readRegular(path.join(sourceRoot, TARGET)), lock.original);
    const common = verifyFile(transformIrFileLineSearch(original), lock.output);
    assert.equal(lock.output.path, TARGET);
    return { lock, lockBytes, original, common };
}
async function receiptFor(input) {
    return { schemaVersion: 1, kind: 'genuine-ir-file-line-search-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), original: input.lock.original, files: [input.lock.output], recipe: RECIPE,
        originalAlgorithmsRetained: true, commonSearchApi: 'IntArray.asList() live view and List.binarySearch(Int)',
        preservesCurrentArrayGetterAndDefaultRange: true,
        fullCommonClassWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareIrFileLineSearch({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); roots(sourceRoot, outputRoot);
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const input = await load(sourceRoot), receipt = await receiptFor(input), filename = path.join(outputRoot, TARGET);
    await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, input.common, { flag: 'wx', mode: 0o600 });
    const reference = path.join(outputRoot, 'reference-original', TARGET); await assertNoSymlink(reference);
    await mkdir(path.dirname(reference), { recursive: true, mode: 0o700 }); await writeFile(reference, input.original, { flag: 'wx', mode: 0o600 });
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath)), commonSources: [filename], replacedOriginalPaths: [TARGET] };
}
async function replay({ sourceRoot, outputRoot, expectedReceiptSha256 }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); roots(sourceRoot, outputRoot);
    const input = await load(sourceRoot), receipt = await receiptFor(input), bytes = await readRegular(path.join(outputRoot, 'receipt.json'));
    assert.equal(sha256(bytes), expectedReceiptSha256, 'IR line search receipt digest changed'); assert.deepEqual(JSON.parse(bytes), receipt, 'IR line search receipt changed');
    assert.deepEqual(await readRegular(path.join(outputRoot, 'reference-original', TARGET)), input.original, 'IR line search full original snapshot changed');
    return { input, receipt, outputRoot };
}
export async function verifyIrFileLineSearch(options) {
    const replayed = await replay(options); verifyFile(await readRegular(path.join(replayed.outputRoot, TARGET)), replayed.receipt.files[0]); return replayed.receipt;
}
export async function verifyFinalIrFileLineSearch({ retainedSources, recordedPropertyImports = [], ...options }) {
    const { input, outputRoot } = await replay(options);
    assert(Array.isArray(retainedSources) && retainedSources.length, 'IR line search actual final selection required');
    const paths = new Set(), filenames = new Set(); let checked;
    for (const row of retainedSources) {
        relativePath(row.path); assert(!paths.has(row.path), 'Duplicate IR line search final logical path'); paths.add(row.path);
        assert(path.isAbsolute(row.filename) && !filenames.has(row.filename), 'Duplicate IR line search final owner'); filenames.add(row.filename);
        if (row.path !== TARGET) continue;
        assert.equal(row.filename, path.join(outputRoot, TARGET), 'Wrong IR line search final owner');
        const bytes = await readRegular(row.filename); assert.equal(bytes.length, row.bytes); assert.equal(sha256(bytes), row.sha256, 'IR line search final source hash changed');
        verifyFile(normalizeTowerImports(bytes, input.common, recordedPropertyImports), input.lock.output);
        checked = { path: row.path, filename: row.filename, bytes: row.bytes, sha256: row.sha256 };
    }
    assert(checked, 'Missing IR line search final source');
    return { schemaVersion: 1, kind: 'genuine-ir-file-line-search-final', sourceLockSha256: sha256(input.lockBytes),
        receiptSha256: options.expectedReceiptSha256, checked: [checked], exactBodyAndOwnerVerified: true, fullCompilerBuilt: false, languageReadiness: false };
}
