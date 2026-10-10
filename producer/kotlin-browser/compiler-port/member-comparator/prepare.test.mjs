import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareMemberComparatorSources, verifyMemberComparator } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources');
const originalPath = 'core/descriptors/src/org/jetbrains/kotlin/resolve/MemberComparator.java';
async function fixture(run) {
    const root = await mkdtemp(path.join(repository, 'out/member-comparator-guards-'));
    try { await run({ root, sourceRoot, outputRoot: path.join(root, 'common') }); }
    finally { await rm(root, { recursive: true, force: true }); }
}

test('full comparator preserves its license, original snapshot and exact common output', async () => fixture(async options => {
    const before = await readFile(path.join(sourceRoot, originalPath));
    const prepared = await prepareMemberComparatorSources(options), checked = await verifyMemberComparator(prepared.outputRoot);
    assert.equal(prepared.commonSources.length, 1); assert.deepEqual(prepared.replacedOriginalPaths, [originalPath]);
    assert.deepEqual(await readFile(prepared.commonSources[0]), await readFile(path.join(here, 'MemberComparator.kt')));
    assert.deepEqual(await readFile(path.join(sourceRoot, originalPath)), before);
    assert.deepEqual(checked.receipt, prepared.receipt);
}));

test('changed pinned source and symlinked source cannot prepare the comparator', async () => fixture(async options => {
    const localSource = path.join(options.root, 'source'), original = path.join(localSource, originalPath);
    await mkdir(path.dirname(original), { recursive: true }); await writeFile(original, 'changed');
    await assert.rejects(prepareMemberComparatorSources({ ...options, sourceRoot: localSource }));
    await rm(original); await symlink(path.join(sourceRoot, originalPath), original);
    await assert.rejects(prepareMemberComparatorSources({ ...options, sourceRoot: localSource }), /Symlink/);
}));

test('changed prepared algorithms, references and readiness claims fail replay', async () => fixture(async options => {
    const prepared = await prepareMemberComparatorSources(options), receipt = JSON.parse(await readFile(prepared.receiptPath));
    for (const change of [{ fullCompilerBuilt: true }, { languageReadiness: true }, { wasmRuntime: 'pass' },
        { sourceAlgorithm: [] }, { files: [] }, { replacedOriginalPaths: [] }, { dependencies: [{ path: 'unbound.kt' }] }]) {
        await writeFile(prepared.receiptPath, JSON.stringify({ ...receipt, ...change })); await assert.rejects(verifyMemberComparator(prepared.outputRoot));
    }
    await writeFile(prepared.receiptPath, JSON.stringify(receipt)); await verifyMemberComparator(prepared.outputRoot);
    const output = await readFile(prepared.commonSources[0]);
    await writeFile(prepared.commonSources[0], output.toString().replace('return 0', 'return 1'));
    await assert.rejects(verifyMemberComparator(prepared.outputRoot));
    await writeFile(prepared.commonSources[0], output);
    await writeFile(path.join(prepared.outputRoot, 'reference', originalPath), 'changed');
    await assert.rejects(verifyMemberComparator(prepared.outputRoot));
}));

test('overlap, reused output and symlinked publication fail closed', async () => fixture(async options => {
    for (const outputRoot of [sourceRoot, path.join(sourceRoot, 'nested'), repository])
        await assert.rejects(prepareMemberComparatorSources({ ...options, outputRoot }));
    await prepareMemberComparatorSources(options); await assert.rejects(prepareMemberComparatorSources(options), /EEXIST/);
    const link = path.join(options.root, 'link'); await symlink(options.outputRoot, link);
    await assert.rejects(prepareMemberComparatorSources({ ...options, outputRoot: link }), /Symlink/);
}));
