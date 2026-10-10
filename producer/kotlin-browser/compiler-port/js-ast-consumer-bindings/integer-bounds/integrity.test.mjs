import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular } from '../../../scripts/source.mjs';
import { prepareAstIntegerConsumer } from '../integer/prepare.mjs';
import { prepareAstIntegerBounds, verifyAstIntegerBounds } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../../..');
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const root = await mkdtemp(path.join(REPO, 'out/kotlin-js-ast-integer-bounds/guards-'));
let passed = 0;
async function test(name, body) { await body(); passed++; console.log('PASS ' + name); }
async function fixture(name) { const preparedInteger = await prepareAstIntegerConsumer({ sourceRoot, outputRoot: path.join(root, name + '-integer') }); const outputRoot = path.join(root, name); const prepared = await prepareAstIntegerBounds({ sourceRoot, outputRoot, preparedInteger }); return { sourceRoot, outputRoot, preparedInteger, ...prepared }; }
await test('Exact chained preparation verifies', async () => { const f = await fixture('exact'); await verifyAstIntegerBounds(f); });
await test('Modified predecessor source rejected', async () => { const f = await fixture('pred-source'); await writeFile(f.preparedInteger.commonSources[0], '// mutated'); await assert.rejects(verifyAstIntegerBounds(f)); });
await test('False predecessor claim rejected', async () => { const f = await fixture('pred-claim'); f.preparedInteger.receipt.byteBufferPorted = true; await writeFile(f.preparedInteger.receiptPath, JSON.stringify(f.preparedInteger.receipt)); await assert.rejects(verifyAstIntegerBounds(f)); });
await test('Modified guarded output rejected', async () => { const f = await fixture('output'); await writeFile(f.commonSources[0], '// mutated'); await assert.rejects(verifyAstIntegerBounds(f)); });
await test('False guarded full compiler claim rejected', async () => { const f = await fixture('claim'); f.receipt.fullCompilerBuilt = true; await writeFile(f.receiptPath, JSON.stringify(f.receipt)); await assert.rejects(verifyAstIntegerBounds(f)); });
await test('Changed predecessor filename binding rejected', async () => { const f = await fixture('binding'); f.receipt.predecessorBindings[0].filename += '-other'; await writeFile(f.receiptPath, JSON.stringify(f.receipt)); await assert.rejects(verifyAstIntegerBounds(f)); });
await test('Existing output rejected', async () => { const f = await fixture('existing'); await assert.rejects(prepareAstIntegerBounds(f)); });
await test('Symlink output rejected', async () => { const preparedInteger = await prepareAstIntegerConsumer({ sourceRoot, outputRoot: path.join(root, 'symlink-integer') }); const target = path.join(root, 'target'); await mkdir(target); const outputRoot = path.join(root, 'link'); await symlink(target, outputRoot); await assert.rejects(prepareAstIntegerBounds({ sourceRoot, outputRoot, preparedInteger })); });
console.log(JSON.stringify({ passed, failed: 0, skipped: 0, output: root }));
