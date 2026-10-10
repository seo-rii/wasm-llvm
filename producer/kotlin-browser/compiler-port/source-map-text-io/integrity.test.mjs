import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSourceMapTextIo, verifySourceMapTextIo } from './prepare.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const parent = path.join(REPO, 'out/kotlin-source-map-text-io'); await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, 'guards-')); let passed = 0;
async function fresh() { const outputRoot = await mkdtemp(path.join(root, 'case-')); const prepared = await prepareSourceMapTextIo({ outputRoot }); return { outputRoot, receiptPath: prepared.receiptPath, prepared }; }
async function check(name, action) { await action(); passed++; console.log('PASS ' + name); }
await check('Canonical preparation', async () => { await verifySourceMapTextIo(await fresh()); });
for (const name of ['fullParserRuntimeBuilt', 'requestStdoutInstalled', 'differentialValidated', 'sharedDependencies', 'originalRuntimeReferences']) {
    await check('Changed receipt ' + name + ' rejected', async () => { const options = await fresh(); const receipt = JSON.parse(await readFile(options.receiptPath)); receipt[name] = Array.isArray(receipt[name]) ? [] : true;
        await writeFile(options.receiptPath, JSON.stringify(receipt)); await assert.rejects(verifySourceMapTextIo(options)); });
}
for (const index of [0, 1]) await check('Changed shipping output ' + index + ' rejected', async () => { const options = await fresh(); await writeFile(options.prepared.commonSources[index], 'mutation'); await assert.rejects(verifySourceMapTextIo(options)); });
await check('Existing preparation rejected', async () => { const options = await fresh(); const before = await readFile(options.prepared.commonSources[0]); await assert.rejects(prepareSourceMapTextIo(options)); assert.deepEqual(await readFile(options.prepared.commonSources[0]), before); });
await check('Symlink output rejected', async () => { const options = await fresh(); const alias = options.outputRoot + '-alias'; await symlink(options.outputRoot, alias); await assert.rejects(prepareSourceMapTextIo({ outputRoot: alias })); });
console.log(JSON.stringify({ passed, failed: 0, skipped: 0, output: root }));
