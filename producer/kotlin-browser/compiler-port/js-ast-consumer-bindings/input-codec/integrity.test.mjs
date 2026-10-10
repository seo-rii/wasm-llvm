import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular } from '../../../scripts/source.mjs';
import { prepareJsAstInput, verifyJsAstInput } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../../..');
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
const root = await mkdtemp(path.join(REPO, 'out/kotlin-js-ast-input/guards-')); let passed = 0;
async function test(name, body) { await body(); passed++; console.log('PASS ' + name); }
async function fixture(name) { const outputRoot = path.join(root, name), prepared = await prepareJsAstInput({ sourceRoot, outputRoot }); return { sourceRoot, outputRoot, ...prepared }; }
await test('Exact input preparation verifies', async () => { await verifyJsAstInput(await fixture('exact')); });
await test('Primitive implementation mutation rejected', async () => { const f = await fixture('source'); await writeFile(f.commonSources[0], '// changed'); await assert.rejects(verifyJsAstInput(f)); });
await test('False integrated-consumer claim rejected', async () => { const f = await fixture('claim'); f.receipt.consumerIntegrated = true; await writeFile(f.receiptPath, JSON.stringify(f.receipt)); await assert.rejects(verifyJsAstInput(f)); });
await test('UTF8 dependency identity mutation rejected', async () => { const f = await fixture('dependency'); f.receipt.sharedDependencies = []; await writeFile(f.receiptPath, JSON.stringify(f.receipt)); await assert.rejects(verifyJsAstInput(f)); });
await test('JVM facade claim rejected', async () => { const f = await fixture('facade'); f.receipt.javaFacadeIntroduced = true; await writeFile(f.receiptPath, JSON.stringify(f.receipt)); await assert.rejects(verifyJsAstInput(f)); });
await test('Existing output rejected', async () => { const f = await fixture('existing'); await assert.rejects(prepareJsAstInput(f)); });
await test('Symlink output rejected', async () => { const target = path.join(root, 'target'); await mkdir(target); const outputRoot = path.join(root, 'link'); await symlink(target, outputRoot); await assert.rejects(prepareJsAstInput({ sourceRoot, outputRoot })); });
await test('Pinned actual consumer mutation rejected', async () => { const changed = path.join(root, 'changed'), filename = path.join(changed, lock.consumer.path); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, '// changed'); await assert.rejects(prepareJsAstInput({ sourceRoot: changed, outputRoot: path.join(root, 'changed-out') })); });
console.log(JSON.stringify({ passed, failed: 0, skipped: 0, output: root }));
