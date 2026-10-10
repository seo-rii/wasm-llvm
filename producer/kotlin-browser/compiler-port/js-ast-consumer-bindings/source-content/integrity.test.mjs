import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular } from '../../../scripts/source.mjs';
import { prepareSourceContentBindings, verifySourceContentBindings } from './prepare.mjs';
import { UTILS } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../../..');
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
const root = await mkdtemp(path.join(REPO, 'out/kotlin-js-ast-source-content/guards-')); let passed = 0;
async function test(name, body) { await body(); passed++; console.log('PASS ' + name); }
async function fixture(name) { const outputRoot = path.join(root, name), prepared = await prepareSourceContentBindings({ sourceRoot, outputRoot }); return { sourceRoot, outputRoot, ...prepared }; }
await test('Exact binding verifies', async () => { await verifySourceContentBindings(await fixture('exact')); });
await test('Supplier source mutation rejected', async () => { const f = await fixture('supplier'); await writeFile(f.commonSources[0], '// mutation'); await assert.rejects(verifySourceContentBindings(f)); });
await test('Registry source mutation rejected', async () => { const f = await fixture('registry'); await writeFile(f.commonSources[1], '// mutation'); await assert.rejects(verifySourceContentBindings(f)); });
await test('False readiness claim rejected', async () => { const f = await fixture('claim'); f.receipt.languageReadiness = true; await writeFile(f.receiptPath, JSON.stringify(f.receipt)); await assert.rejects(verifySourceContentBindings(f)); });
await test('Dependency identity mutation rejected', async () => { const f = await fixture('dependencies'); f.receipt.dependencyPins = []; await writeFile(f.receiptPath, JSON.stringify(f.receipt)); await assert.rejects(verifySourceContentBindings(f)); });
await test('Existing output rejected', async () => { const f = await fixture('existing'); await assert.rejects(prepareSourceContentBindings(f)); });
await test('Symlink output rejected', async () => { const target = path.join(root, 'target'); await mkdir(target); const outputRoot = path.join(root, 'link'); await symlink(target, outputRoot); await assert.rejects(prepareSourceContentBindings({ sourceRoot, outputRoot })); });
await test('Pinned original consumer mutation rejected', async () => { const changed = path.join(root, 'changed'); for (const pin of lock.sources) { const filename = path.join(changed, pin.path); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, await readRegular(path.join(sourceRoot, pin.path))); } await writeFile(path.join(changed, UTILS), '// changed'); await assert.rejects(prepareSourceContentBindings({ sourceRoot: changed, outputRoot: path.join(root, 'changed-out') })); });
console.log(JSON.stringify({ passed, failed: 0, skipped: 0, output: root }));
