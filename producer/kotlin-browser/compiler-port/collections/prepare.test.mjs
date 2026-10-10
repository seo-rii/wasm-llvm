import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareCollectionsSources } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const recipe = JSON.parse(await readFile(path.join(here, 'collections.recipe.json'), 'utf8'));
const canonical = path.join(repository, 'out/kotlin-compiler-port/sources');

async function fixture(t) {
    const root = await mkdtemp(path.join(repository, 'out/kotlin-collections-integrity-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourceRoot = path.join(root, 'sources');
    const outputRoot = path.join(root, 'output');
    await mkdir(sourceRoot);
    for (const pin of recipe.originals) {
        const destination = path.join(sourceRoot, pin.path);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, await readFile(path.join(canonical, pin.path)), { flag: 'wx' });
    }
    return { root, sourceRoot, outputRoot };
}

test('prepared sources preserve original bytes and caller changes only its generic signature', async (t) => {
    const f = await fixture(t);
    const before = await Promise.all(recipe.originals.map((pin) => readFile(path.join(f.sourceRoot, pin.path))));
    const prepared = await prepareCollectionsSources(f);
    assert.equal(prepared.commonSources.length, 3);
    assert.deepEqual(prepared.replacedOriginalPaths, recipe.callerTransformations.map((pin) => pin.originalPath));
    for (let i = 0; i < recipe.originals.length; i++) assert.deepEqual(await readFile(path.join(f.sourceRoot, recipe.originals[i].path)), before[i]);
    const caller = recipe.callerTransformations[0];
    const transformed = await readFile(prepared.commonSources.find((file) => file.endsWith(caller.path)), 'utf8');
    const original = await readFile(path.join(f.sourceRoot, caller.originalPath), 'utf8');
    assert.equal(transformed.replace(caller.replacements[0].to, caller.replacements[0].from), original);
    assert(transformed.includes('private class Graph<T>'));
    assert(transformed.includes('result.add(current)'));
});

test('oversized pinned Java input rejects source preparation before receipt publication', async (t) => {
    const f = await fixture(t);
    const pin = recipe.originals.find((pin) => pin.path.endsWith('/DFS.java'));
    await writeFile(path.join(f.sourceRoot, pin.path), Buffer.alloc(pin.bytes + 1));
    await assert.rejects(prepareCollectionsSources(f), /bounded regular file/);
    await assert.rejects(readFile(path.join(f.outputRoot, 'compiler-port-collections/collections-inputs.json')), { code: 'ENOENT' });
});

test('same-sized altered source fails its original blob and SHA256 check', async (t) => {
    const f = await fixture(t);
    const pin = recipe.originals.find((pin) => pin.path.endsWith('/SmartList.java'));
    const bytes = await readFile(path.join(f.sourceRoot, pin.path));
    bytes[0] ^= 1;
    await writeFile(path.join(f.sourceRoot, pin.path), bytes);
    await assert.rejects(prepareCollectionsSources(f), /Pinned source content mismatch/);
});

test('symlinked caller source cannot substitute for the actual selected pinned declaration', async (t) => {
    const f = await fixture(t);
    const pin = recipe.originals.find((pin) => pin.path.endsWith('.kt'));
    const destination = path.join(f.sourceRoot, pin.path);
    await rm(destination);
    await symlink(path.join(canonical, pin.path), destination);
    await assert.rejects(prepareCollectionsSources(f), /Symlink paths are not accepted/);
});

test('output symlink and output beneath source cache are rejected before mutation', async (t) => {
    const f = await fixture(t);
    await symlink(f.sourceRoot, f.outputRoot);
    await assert.rejects(prepareCollectionsSources(f), /Symlink paths are not accepted/);
    await assert.rejects(prepareCollectionsSources({ ...f, outputRoot: path.join(f.sourceRoot, 'new-output') }), /Do not modify the original source cache/);
});

test('pre-existing output remains intact and failed preparation has no success receipt', async (t) => {
    const f = await fixture(t);
    const root = path.join(f.outputRoot, 'compiler-port-collections');
    await mkdir(root, { recursive: true });
    const existing = path.join(root, 'DFS.kt');
    await writeFile(existing, 'keep-this-output');
    await assert.rejects(prepareCollectionsSources(f), { code: 'EEXIST' });
    assert.equal(await readFile(existing, 'utf8'), 'keep-this-output');
    await assert.rejects(readFile(path.join(root, 'collections-inputs.json')), { code: 'ENOENT' });
});
