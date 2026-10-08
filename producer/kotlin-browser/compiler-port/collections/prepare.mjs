import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');

export async function prepareCollectionsSources({ sourceRoot, outputRoot }) {
    assert(sourceRoot && outputRoot, 'sourceRoot and outputRoot required');
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep), 'Collections output must stay under repository out/');
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Do not modify the original source cache');
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const recipeBytes = await readRegular(path.join(here, 'collections.recipe.json'));
    const recipe = JSON.parse(recipeBytes);
    assert.equal(recipe.schemaVersion, 1);
    assert.equal(recipe.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    const originals = new Map();
    for (const pin of recipe.originals) originals.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, relativePath(pin.path)), pin.bytes), pin));
    const prepared = [];
    for (const pin of recipe.portable) {
        const bytes = await readRegular(path.join(here, relativePath(pin.path)), pin.bytes);
        assert.equal(bytes.byteLength, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
        prepared.push({ pin, bytes });
    }
    for (const pin of recipe.callerTransformations) {
        let text = originals.get(pin.originalPath).toString('utf8');
        for (const { from, to } of pin.replacements) {
            assert.equal(text.split(from).length, 2, 'Caller signature must match exactly once');
            text = text.replace(from, to);
        }
        const bytes = Buffer.from(text);
        assert.equal(bytes.byteLength, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
        prepared.push({ pin, bytes });
    }
    const root = path.join(outputRoot, 'compiler-port-collections');
    await assertNoSymlink(root); await mkdir(root, { recursive: true });
    const commonSources = [];
    for (const { pin, bytes } of prepared) {
        const destination = path.join(root, relativePath(pin.path));
        await assertNoSymlink(destination); await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
        commonSources.push(destination);
    }
    for (const pin of recipe.originals) verifyFile(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), pin);
    const replacedOriginalPaths = recipe.callerTransformations.map((pin) => pin.originalPath);
    const receipt = { schemaVersion: 1, kind: 'official-compiler-collections-host-source-preparation', source: recipe.source,
        recipeSha256: sha256(recipeBytes), originals: recipe.originals, portable: recipe.portable, callerTransformations: recipe.callerTransformations,
        commonBaseSourceProvenance: recipe.commonBaseSourceProvenance,
        replacedOriginalPaths, originalSourcesUnmodified: true, hostProfile: 'single-serial-Worker',
        browserCompiler: 'not-built', languageReadiness: false };
    const receiptPath = path.join(root, 'collections-inputs.json');
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { commonSources, replacedOriginalPaths, receipt, receiptPath };
}
