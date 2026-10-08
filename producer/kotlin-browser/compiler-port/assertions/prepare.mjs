import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');

export async function prepareAssertionSources({ outputRoot, stdlibSourceRoot = path.join(repository, 'out/kotlin-stdlib-probe/sources') }) {
    outputRoot = path.resolve(outputRoot); stdlibSourceRoot = path.resolve(stdlibSourceRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    assert(outputRoot !== stdlibSourceRoot && !stdlibSourceRoot.startsWith(outputRoot + path.sep));
    await assertNoSymlink(outputRoot); await assertNoSymlink(stdlibSourceRoot);
    const recipeBytes = await readRegular(path.join(here, 'sources.lock.json'));
    const recipe = JSON.parse(recipeBytes);
    const original = verifyFile(await readRegular(path.join(stdlibSourceRoot, recipe.original.path), recipe.original.bytes), recipe.original);
    const text = original.toString();
    const expected = text.slice(text.indexOf('internal actual fun assert(value: Boolean)')).replace('internal actual fun assert', 'inline fun compilerAssert')
        .replace('    assert(value)', '    compilerAssert(value)')
        .replace('@UsedFromCompilerGeneratedCode\ninternal actual fun assert', 'inline fun compilerAssert');
    const portable = await readRegular(path.join(here, recipe.portable.path), recipe.portable.bytes);
    assert.equal(portable.length, recipe.portable.bytes); assert.equal(sha256(portable), recipe.portable.sha256);
    const functions = portable.toString().slice(portable.toString().indexOf('inline fun compilerAssert'));
    // Keep both exact check/lazy-message/throw algorithms, changing declaration
    // visibility/inline host spelling only. No disabled-check branch is added.
    assert.equal(functions.replace(/\/\*\*[\s\S]*?\*\/\n/g, ''), expected.replace(/\/\*\*[\s\S]*?\*\/\n/g, ''));
    const root = path.join(outputRoot, 'compiler-port-assertions'); await mkdir(root, { recursive: true });
    const filename = path.join(root, recipe.portable.path);
    await writeFile(filename, portable, { flag: 'wx', mode: 0o600 });
    const receipt = { schemaVersion: 1, kind: 'official-compiler-enabled-assertion-host-preparation', source: recipe.source,
        recipeSha256: sha256(recipeBytes), original: recipe.original, portable: recipe.portable,
        policy: 'enabled compiler invariant checks; JVM reference requires -ea', fullBrowserCompiler: false };
    await writeJson(path.join(root, 'assertion-inputs.json'), receipt);
    return { commonSources: [filename], receipt, assertionImport: 'org.jetbrains.kotlin.portable.assertions.compilerAssert as assert' };
}
