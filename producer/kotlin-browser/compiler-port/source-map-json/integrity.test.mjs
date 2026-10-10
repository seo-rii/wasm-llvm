import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSourceMapJsonReferences, prepareSourceMapJson, verifySourceMapJson } from './prepare.mjs';
import { verifySourceMapTree } from './verify-tree.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const reference = await prepareSourceMapJsonReferences();
await mkdir(path.join(REPO, 'out/kotlin-source-map-json'), { recursive: true });
const root = await mkdtemp(path.join(REPO, 'out/kotlin-source-map-json/guards-')); let passed = 0;
async function test(name, body) { await body(); passed++; console.log('PASS ' + name); }
async function fixture(name) {
    const options = { sourceRoot: reference.sourceRoot, outputRoot: path.join(root, name) };
    return { ...options, ...await prepareSourceMapJson(options) };
}
await test('Canonical JSON/ECMA preparation verifies', async () => verifySourceMapJson(await fixture('exact')));
for (const index of [0, 1]) await test('Changed common source ' + index + ' rejected', async () => {
    const f = await fixture('source-' + index); await writeFile(f.commonSources[index], '// changed'); await assert.rejects(verifySourceMapJson(f));
});
for (const [field, value] of [['differentialValidated', true], ['methodsRemoved', true], ['parserRuntimeBuilt', true],
    ['originalIndexSectionsSupported', true], ['jsTree', {}], ['sharedDependencies', []]]) {
    await test('Changed receipt ' + field + ' rejected', async () => {
        const f = await fixture(field); f.receipt[field] = value; await writeFile(f.receiptPath, JSON.stringify(f.receipt)); await assert.rejects(verifySourceMapJson(f));
    });
}
await test('Existing output rejected without changing source', async () => {
    const f = await fixture('existing'); await assert.rejects(prepareSourceMapJson(f)); await verifySourceMapJson(f);
});
await test('Symlink output rejected', async () => {
    const target = path.join(root, 'target'); await mkdir(target); const outputRoot = path.join(root, 'link'); await symlink(target, outputRoot);
    await assert.rejects(prepareSourceMapJson({ sourceRoot: reference.sourceRoot, outputRoot }));
});
await test('Source/output overlap rejected', async () => assert.rejects(prepareSourceMapJson({ sourceRoot: reference.sourceRoot, outputRoot: reference.sourceRoot })));
for (const mutation of ['sourceBlob', 'sourcePath', 'treeBytes', 'missingBranch']) await test('Changed rooted source proof ' + mutation + ' rejected', async () => {
    const lock = JSON.parse(await readFile(path.join(HERE, 'sources.lock.json')));
    if (mutation === 'sourceBlob') lock.sources[0].gitBlob = '0'.repeat(40);
    if (mutation === 'sourcePath') lock.sources[0].path = 'js/js.parser/src/Outside.kt';
    if (mutation === 'treeBytes') lock.treeProof[0].entries[0].sha = '0'.repeat(40);
    if (mutation === 'missingBranch') lock.treeProof.pop();
    assert.throws(() => verifySourceMapTree(lock));
});
console.log(JSON.stringify({ passed, failed: 0, skipped: 0, output: root }));
