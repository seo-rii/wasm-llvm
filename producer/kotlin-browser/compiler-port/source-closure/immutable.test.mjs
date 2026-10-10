import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareImmutableDependency, verifyImmutableDependency } from './immutable.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const REPO = path.resolve(HERE, '../../../..');
const lock = JSON.parse(await readFile(path.join(HERE, 'immutable.lock.json')));

async function fixture(run) {
    const root = await mkdtemp(path.join(REPO, 'out/kotlin-immutable-guard-'));
    try {
        const cacheRoot = path.join(root, 'cache'); const sourceRoot = path.join(root, 'sources');
        await cp(path.join(REPO, 'out/kotlin-source-closure-reference/immutable'), cacheRoot, { recursive: true });
        await mkdir(path.join(sourceRoot, 'gradle'), { recursive: true });
        await cp(path.join(REPO, 'out/kotlin-source-closure-reference/sources/gradle/versions.properties'), path.join(sourceRoot, 'gradle/versions.properties'));
        const options = { outputRoot: path.join(root, 'output'), cacheRoot, sourceRoot, fetcher: () => { throw new Error('Unexpected network request'); } };
        await run({ root, options });
    } finally { await rm(root, { recursive: true, force: true }); }
}

test('Actual declared immutable0.5.1 wasmJs variant binds verified KLIB bytes and source provenance', async () => fixture(async f => {
    const prepared = await prepareImmutableDependency(f.options); const verified = await verifyImmutableDependency(path.dirname(prepared.receiptPath));
    assert.equal(verified.libraryPath, prepared.libraryPath); assert.equal(verified.receipt.version, '0.5.1');
    assert.equal(verified.receipt.manifest.wasm_targets, 'wasm-js'); assert.equal(verified.receipt.manifest.compiler_version, '2.3.0');
    assert.equal(verified.receipt.languageReadiness, false); assert.equal(verified.receipt.compilerCompatibility, 'not-run by artifact preparation');
}));
test('Corrupt published KLIB is rejected before a preparation receipt', async () => fixture(async f => {
    const file = path.join(f.options.cacheRoot, lock.library); const bytes = await readFile(file); bytes[100] ^= 1; await writeFile(file, bytes);
    await assert.rejects(prepareImmutableDependency(f.options), /Immutable dependency content mismatch/);
    await assert.rejects(readFile(path.join(f.options.outputRoot, 'compiler-immutable/receipt.json')), { code: 'ENOENT' });
}));
test('Changed upstream declared version cannot select arbitrary newer immutable algorithms', async () => fixture(async f => {
    const file = path.join(f.options.sourceRoot, 'gradle/versions.properties'); const bytes = await readFile(file); bytes[100] ^= 1; await writeFile(file, bytes);
    await assert.rejects(prepareImmutableDependency(f.options), /Pinned source content mismatch/);
}));
test('Cache overlap and artifact symlinks are rejected', async () => fixture(async f => {
    await assert.rejects(prepareImmutableDependency({ ...f.options, outputRoot: path.join(f.options.cacheRoot, 'generated') }), /overlaps original cache/);
    await assert.rejects(prepareImmutableDependency({ ...f.options, outputRoot: path.join(f.options.sourceRoot, 'generated') }), /overlaps original cache/);
    const file = path.join(f.options.cacheRoot, lock.library); const target = path.join(f.root, 'redirected.klib'); await cp(file, target); await rm(file); await symlink(target, file);
    await assert.rejects(prepareImmutableDependency(f.options), /Symlink paths/);
}));
test('Existing artifacts remain intact and readiness claims cannot be forged', async () => fixture(async f => {
    const prepared = await prepareImmutableDependency(f.options); const before = await readFile(prepared.receiptPath);
    await assert.rejects(prepareImmutableDependency(f.options), { code: 'EEXIST' }); assert.deepEqual(await readFile(prepared.receiptPath), before);
    const changed = JSON.parse(before); changed.languageReadiness = true; await writeFile(prepared.receiptPath, JSON.stringify(changed));
    await assert.rejects(verifyImmutableDependency(path.dirname(prepared.receiptPath)), /Stale immutable dependency receipt/);
}));
