import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareRegistrySources } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const recipe = JSON.parse(await readFile(path.join(here, 'registry.recipe.json'), 'utf8'));
const canonical = path.join(repository, 'out/kotlin-compiler-port/sources');

async function fixture(t) {
    const root = await mkdtemp(path.join(repository, 'out/kotlin-registry-integrity-'));
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

test('verified registry source preparation keeps originals and emits exact keyed source replacements', async (t) => {
    const f = await fixture(t);
    const before = await Promise.all(recipe.originals.map((pin) => readFile(path.join(f.sourceRoot, pin.path))));
    const prepared = await prepareRegistrySources(f);
    assert.deepEqual(prepared.requiredFlags, ['-Xwasm-kclass-fqn']);
    assert.equal(prepared.commonSources.length, 5);
    assert.deepEqual(prepared.replacedOriginalPaths, recipe.transformations.map((pin) => pin.originalPath));
    for (let i = 0; i < recipe.originals.length; i++) assert.deepEqual(await readFile(path.join(f.sourceRoot, recipe.originals[i].path)), before[i]);
    assert.equal(JSON.parse(await readFile(prepared.receiptPath, 'utf8')).originalSourcesUnmodified, true);
});

test('oversized pinned input fails before a successful preparation receipt', async (t) => {
    const f = await fixture(t);
    const pin = recipe.originals[0];
    await writeFile(path.join(f.sourceRoot, pin.path), Buffer.alloc(pin.bytes + 1));
    await assert.rejects(prepareRegistrySources(f), /bounded regular file/);
    await assert.rejects(readFile(path.join(f.outputRoot, 'compiler-port-registry/registry-inputs.json')), { code: 'ENOENT' });
});

test('same-sized changed source is rejected by original Git blob and SHA256', async (t) => {
    const f = await fixture(t);
    const pin = recipe.originals[0];
    const bytes = await readFile(path.join(f.sourceRoot, pin.path));
    bytes[0] ^= 1;
    await writeFile(path.join(f.sourceRoot, pin.path), bytes);
    await assert.rejects(prepareRegistrySources(f), /Pinned source content mismatch/);
});

test('symlinked original source cannot be accepted as the locked regular source', async (t) => {
    const f = await fixture(t);
    const pin = recipe.originals[0];
    const destination = path.join(f.sourceRoot, pin.path);
    await rm(destination);
    await symlink(path.join(canonical, pin.path), destination);
    await assert.rejects(prepareRegistrySources(f), /Symlink paths are not accepted/);
});

test('symlinked output and output nested in original cache are rejected before mutation', async (t) => {
    const f = await fixture(t);
    await symlink(f.sourceRoot, f.outputRoot);
    await assert.rejects(prepareRegistrySources(f), /Symlink paths are not accepted/);
    await assert.rejects(prepareRegistrySources({ ...f, outputRoot: path.join(f.sourceRoot, 'new-output') }), /Do not modify the original source cache/);
});

test('existing output is kept intact and no success receipt is published on collision', async (t) => {
    const f = await fixture(t);
    const root = path.join(f.outputRoot, 'compiler-port-registry');
    await mkdir(root, { recursive: true });
    const existing = path.join(root, 'RegistryHost.kt');
    await writeFile(existing, 'keep-this-output');
    await assert.rejects(prepareRegistrySources(f), { code: 'EEXIST' });
    assert.equal(await readFile(existing, 'utf8'), 'keep-this-output');
    await assert.rejects(readFile(path.join(root, 'registry-inputs.json')), { code: 'ENOENT' });
});
