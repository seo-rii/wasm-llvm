import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, writeJson } from '../../../scripts/source.mjs';
import { prepareAstIntegerConsumer, guardSelectedIntegerConsumers, DESERIALIZER, OPERATIONS } from './prepare.mjs';
import { verifyAstIntegerConsumerPreparation } from './verify.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../../..');
const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
const root = await mkdtemp(path.join(REPO, 'out/kotlin-js-ast-integer-consumer/guards-'));
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'); let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }
async function prepared(name) { const outputRoot = path.join(root, name); const result = await prepareAstIntegerConsumer({ sourceRoot, outputRoot }); return { outputRoot, ...result }; }
await test('Exact import-only preparation verifies', async () => { const p = await prepared('exact'); await verifyAstIntegerConsumerPreparation({ sourceRoot, ...p }); });
await test('Prepared source tampering rejected', async () => { const p = await prepared('source'); await writeFile(p.commonSources[0], '// tampered'); await assert.rejects(verifyAstIntegerConsumerPreparation({ sourceRoot, ...p })); });
await test('False full-deserializer claim rejected', async () => { const p = await prepared('claim'); p.receipt.fullDeserializerBuilt = true; await writeFile(p.receiptPath, JSON.stringify(p.receipt)); await assert.rejects(verifyAstIntegerConsumerPreparation({ sourceRoot, ...p })); });
await test('Receipt source/dependency identity tampering rejected', async () => { const p = await prepared('identity'); p.receipt.astDependencies = []; await writeFile(p.receiptPath, JSON.stringify(p.receipt)); await assert.rejects(verifyAstIntegerConsumerPreparation({ sourceRoot, ...p })); });
await test('Existing output is never overwritten', async () => { const p = await prepared('overwrite'); await assert.rejects(prepareAstIntegerConsumer({ sourceRoot, outputRoot: p.outputRoot })); });
await test('Symlink output rejected', async () => { const target = path.join(root, 'symlink-target'); await mkdir(target); const outputRoot = path.join(root, 'symlink'); await symlink(target, outputRoot); await assert.rejects(prepareAstIntegerConsumer({ sourceRoot, outputRoot })); });
await test('Pinned original mutation rejected', async () => { const changed = path.join(root, 'original'); for (const pin of lock.sources) { const filename = path.join(changed, pin.path); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, await readRegular(path.join(sourceRoot, pin.path))); } await writeFile(path.join(changed, DESERIALIZER), '// changed'); await assert.rejects(prepareAstIntegerConsumer({ sourceRoot: changed, outputRoot: path.join(root, 'changed-out') })); });
await test('New selected BigInteger consumer rejected', async () => { const extra = path.join(root, 'Extra.kt'); await writeFile(extra, 'import java.math.BigInteger\n'); await assert.rejects(guardSelectedIntegerConsumers([{ path: DESERIALIZER, filename: path.join(sourceRoot, DESERIALIZER) }, { path: OPERATIONS, filename: path.join(sourceRoot, OPERATIONS) }, { path: 'unexpected/Extra.kt', filename: extra }])); });
console.log(JSON.stringify({ passed, failed: 0, skipped: 0, output: root }));
