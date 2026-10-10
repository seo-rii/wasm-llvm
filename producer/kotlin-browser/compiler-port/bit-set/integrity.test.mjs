import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareBitSetSources, verifyBitSetPreparation } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); const REPO = path.resolve(HERE, '../../../..');
const lock = JSON.parse(await readFile(path.join(HERE, 'sources.lock.json')));
async function fixture(operation) {
  const root = await mkdtemp(path.join(REPO, 'out/bit-set-test-'));
  const sourceRoot = path.join(root, 'original'), referenceRoot = path.join(root, 'jdk'), outputRoot = path.join(root, 'prepared');
  await mkdir(sourceRoot); await mkdir(referenceRoot);
  for (const pin of lock.consumers) {
    const filename = path.join(sourceRoot, pin.path); await mkdir(path.dirname(filename), { recursive: true });
    await copyFile(path.join(REPO, 'out/kotlin-compiler-port/sources', pin.path), filename);
  }
  await copyFile(path.join(REPO, 'out/kotlin-bit-set-reference/BitSet.java'), path.join(referenceRoot, 'BitSet.java'));
  try { await operation({ root, sourceRoot, referenceRoot, outputRoot }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('Exact selected compiler utility/lowering bodies survive import preparation', async () => fixture(async options => {
  const result = await prepareBitSetSources(options); const checked = await verifyBitSetPreparation(options.outputRoot);
  assert.equal(result.commonSources.length, 3); assert.deepEqual(result.replacedOriginalPaths, lock.consumers.map(pin => pin.path));
  assert.equal(checked.receipt.languageReadiness, false);
  for (const pin of lock.consumers) {
    const original = await readFile(path.join(options.sourceRoot, pin.path), 'utf8');
    const prepared = await readFile(path.join(options.outputRoot, pin.path), 'utf8');
    assert.equal(prepared.replace('import org.jetbrains.kotlin.portable.bits.BitSet', pin.path.endsWith('/BitSetUtil.kt') ? 'import java.util.BitSet' : 'import java.util.*'), original);
  }
}));

test('Changed official compiler and JDK inputs are rejected before evidence publication', async () => fixture(async options => {
  const filename = path.join(options.sourceRoot, lock.consumers[0].path); const bytes = await readFile(filename);
  await writeFile(filename, Buffer.concat([bytes, Buffer.from('\n')]));
  await assert.rejects(prepareBitSetSources(options), /Pinned source/);
  await writeFile(filename, bytes);
  await writeFile(path.join(options.referenceRoot, 'BitSet.java'), 'changed');
  await assert.rejects(prepareBitSetSources(options), /Pinned source/);
}));

test('Both source-cache roots and descendants reject output overlap', async () => fixture(async options => {
  for (const cache of [options.sourceRoot, options.referenceRoot]) for (const outputRoot of [cache, path.join(cache, 'generated')]) {
    await assert.rejects(prepareBitSetSources({ ...options, outputRoot }), /overlaps original cache/);
  }
}));

test('Symlinks and existing outputs cannot replace source or published artifacts', async () => fixture(async options => {
  const link = path.join(options.root, 'source-link'); await symlink(options.sourceRoot, link);
  await assert.rejects(prepareBitSetSources({ ...options, sourceRoot: link }), /Symlink/);
  await prepareBitSetSources(options);
  const filename = path.join(options.outputRoot, 'bit-set-inputs.json'), before = await readFile(filename);
  await assert.rejects(prepareBitSetSources(options), /EEXIST/);
  assert.deepEqual(await readFile(filename), before);
}));

test('Changed generated algorithm and omitted compiler consumer receipt are rejected', async () => fixture(async options => {
  await prepareBitSetSources(options);
  const algorithm = path.join(options.outputRoot, 'compiler-port-bit-set/BitSet.kt'), bytes = await readFile(algorithm);
  await writeFile(algorithm, Buffer.concat([bytes, Buffer.from('\n')]));
  await assert.rejects(verifyBitSetPreparation(options.outputRoot), /Pinned source/);
  await writeFile(algorithm, bytes);
  const receiptPath = path.join(options.outputRoot, 'bit-set-inputs.json'); const receipt = JSON.parse(await readFile(receiptPath));
  receipt.consumers.pop();
  await writeFile(receiptPath, JSON.stringify(receipt));
  await assert.rejects(verifyBitSetPreparation(options.outputRoot), { name: 'AssertionError' });
}));
