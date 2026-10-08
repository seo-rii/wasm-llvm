import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');

export async function prepareStorageSources({ sourceRoot, outputRoot }) {
    assert(sourceRoot && outputRoot, 'sourceRoot and outputRoot required');
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep), 'Storage output must stay under repository out/');
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep), 'Do not modify the original source cache');
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const recipeBytes = await readRegular(path.join(here, 'storage.recipe.json'));
    const recipe = JSON.parse(recipeBytes);
    assert.equal(recipe.schemaVersion, 1);
    assert.equal(recipe.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    const originals = new Map();
    for (const pin of recipe.originals) {
        originals.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, relativePath(pin.path)), pin.bytes), pin));
    }
    const root = path.join(outputRoot, 'compiler-port-storage');
    await mkdir(root, { recursive: true });
    const commonSources = [];
    const prepared = [];
    for (const pin of recipe.portable) {
        const bytes = await readRegular(path.join(here, relativePath(pin.path)), pin.bytes);
        assert.equal(bytes.byteLength, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
        const destination = path.join(root, pin.path);
        await assertNoSymlink(destination); await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
        commonSources.push(destination); prepared.push(pin);
    }
    for (const pin of recipe.mapInterfaceReplacements) {
        const original = originals.get(pin.originalPath);
        assert(original, 'Map interface original is not verified');
        const text = original.toString('utf8');
        assert.equal(text.split('import java.util.concurrent.ConcurrentMap').length, 2);
        const bytes = Buffer.from(text.replace('import java.util.concurrent.ConcurrentMap', 'import kotlin.collections.MutableMap as ConcurrentMap'));
        assert.equal(sha256(bytes), pin.sha256); assert.equal(bytes.byteLength, pin.bytes);
        const destination = path.join(root, pin.path);
        await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
        commonSources.push(destination); prepared.push(pin);
    }
    for (const pin of recipe.originals) verifyFile(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), pin);
    const replacedOriginalPaths = recipe.replacedOriginalPaths;
    const receipt = { schemaVersion: 1, kind: 'official-compiler-storage-host-source-preparation', source: recipe.source,
        recipeSha256: sha256(recipeBytes), originals: recipe.originals, prepared, replacedOriginalPaths,
        originalSourcesUnmodified: true, hostProfile: 'single-serial-Worker', browserCompiler: 'not-built', languageReadiness: false };
    const receiptPath = path.join(root, 'storage-inputs.json');
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { commonSources, replacedOriginalPaths, receipt, receiptPath };
}
