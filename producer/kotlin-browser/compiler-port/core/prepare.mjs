/** Prepares the real Name dependency for the official compiler source build. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');

export async function prepareCoreSources({ sourceRoot, outputRoot }) {
    assert(sourceRoot && outputRoot, 'sourceRoot and outputRoot are required');
    sourceRoot = path.resolve(sourceRoot);
    outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep), 'Portable core output must stay under repository out/');
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep), 'Do not mutate the original source cache');
    await assertNoSymlink(sourceRoot);
    await assertNoSymlink(outputRoot);
    const recipeBytes = await readRegular(path.join(here, 'name.recipe.json'));
    const recipe = JSON.parse(recipeBytes);
    assert.equal(recipe.schemaVersion, 1);
    assert.equal(recipe.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    assert.equal(recipe.original.path, 'core/names/src/org/jetbrains/kotlin/name/Name.java');
    assert.equal(recipe.portable.path, 'Name.kt');
    assert.equal(recipe.portable.outputPath, 'compiler-port-core/Name.kt');
    const original = verifyFile(await readRegular(path.join(sourceRoot, relativePath(recipe.original.path)), recipe.original.bytes), recipe.original);
    const portable = await readRegular(path.join(here, recipe.portable.path), recipe.portable.bytes);
    assert.equal(portable.byteLength, recipe.portable.bytes);
    assert.equal(sha256(portable), recipe.portable.sha256, 'Portable Name source differs from reviewed recipe');
    const destination = path.join(outputRoot, relativePath(recipe.portable.outputPath));
    await assertNoSymlink(destination);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, portable, { flag: 'wx', mode: 0o600 });
    assert.deepEqual(await readRegular(path.join(sourceRoot, recipe.original.path), original.byteLength), original, 'Original Name source changed');
    const receipt = { schemaVersion: 1, kind: 'official-compiler-core-name-source-preparation', source: recipe.source,
        recipeSha256: sha256(recipeBytes), original: recipe.original, portable: recipe.portable,
        originalSourceUnmodified: true, browserCompiler: 'not-built', languageReadiness: false };
    const receiptPath = path.join(outputRoot, 'compiler-port-core/name-inputs.json');
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { receipt, receiptPath, commonSources: [destination] };
}
