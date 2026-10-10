import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSourceMapBuilder, verifySourceMapBuilder } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), parent = path.join(REPO, 'out/kotlin-source-map-builder-kernel');
await mkdir(parent, { recursive: true, mode: 0o700 }); const root = await mkdtemp(path.join(parent, 'guards-')); let passed = 0;
async function fresh() { const outputRoot = await mkdtemp(path.join(root, 'case-')); const prepared = await prepareSourceMapBuilder({ sourceRoot, outputRoot }); return { sourceRoot, outputRoot, receiptPath: prepared.receiptPath, prepared }; }
async function check(name, action) { await action(); passed++; console.log('PASS ' + name); }
await check('Canonical preparation', async () => { await verifySourceMapBuilder(await fresh()); });
for (const field of ['differentialValidated','callerIntegrated','nativeStacktraceTextParity','pathResolverBuilt','source','tools','sharedDependencies','identityContract','files','primaryClosureSha256']) {
    await check('Changed receipt ' + field + ' rejected', async () => {
        const options = await fresh(), receipt = JSON.parse(await readFile(options.receiptPath));
        receipt[field] = typeof receipt[field] === 'boolean' ? true : Array.isArray(receipt[field]) ? [] : 'mutation';
        await writeFile(options.receiptPath, JSON.stringify(receipt)); await assert.rejects(verifySourceMapBuilder(options));
    });
}
for (const index of [0,1,2]) await check('Changed shipping output ' + index + ' rejected', async () => {
    const options = await fresh(); await writeFile(options.prepared.commonSources[index], 'mutation'); await assert.rejects(verifySourceMapBuilder(options));
});
for (const index of [0,1]) await check('Changed original ' + index + ' rejected', async () => {
    const inputRoot = await mkdtemp(path.join(root, 'original-'));
    const lock = JSON.parse(await readFile(path.join(HERE, 'sources.lock.json'))), ast = JSON.parse(await readFile(path.join(HERE, '../js-ast/sources.lock.json')));
    const sources = [...lock.sources, ...ast.sources.filter(pin => pin.language === 'kotlin')];
    for (const pin of sources) { const filename = path.join(inputRoot, pin.path); await mkdir(path.dirname(filename), { recursive: true }); await copyFile(path.join(sourceRoot, pin.path), filename); }
    await writeFile(path.join(inputRoot, lock.sources[index].path), 'mutation');
    await assert.rejects(prepareSourceMapBuilder({ sourceRoot: inputRoot, outputRoot: await mkdtemp(path.join(root, 'mutated-')) }));
});
await check('Existing preparation rejected without overwriting bytes', async () => {
    const options = await fresh(), before = await readFile(options.prepared.commonSources[0]); await assert.rejects(prepareSourceMapBuilder(options)); assert.deepEqual(await readFile(options.prepared.commonSources[0]), before);
});
await check('Symlink output rejected', async () => { const options = await fresh(), alias = options.outputRoot + '-alias'; await symlink(options.outputRoot, alias); await assert.rejects(prepareSourceMapBuilder({ sourceRoot, outputRoot: alias })); });
console.log(JSON.stringify({ passed, failed: 0, skipped: 0, output: root }));
