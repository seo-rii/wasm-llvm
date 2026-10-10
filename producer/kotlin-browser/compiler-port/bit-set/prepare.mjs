/** Exact compiler consumer import rebinding and selected OpenJDK word algorithm preparation. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, gitBlob, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const IMPORT = 'org.jetbrains.kotlin.portable.bits.BitSet';

export async function prepareBitSetReferences({ referenceRoot = path.join(REPO, 'out/kotlin-bit-set-reference') } = {}) {
  referenceRoot = path.resolve(referenceRoot);
  assert(referenceRoot.startsWith(path.join(REPO, 'out') + path.sep)); await assertNoSymlink(referenceRoot);
  const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
  const pin = lock.jdk, filename = path.join(referenceRoot, relativePath(pin.path));
  try { verifyFile(await readRegular(filename), pin); return { referenceRoot, pin }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetch('https://raw.githubusercontent.com/openjdk/jdk17u/' + lock.jdk.commit + '/' + pin.sourcePath, { signal: AbortSignal.timeout(30000) });
  assert(response.ok && response.body, 'Pinned BitSet reference download failed');
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) { size += chunk.length; assert(size <= pin.bytes); chunks.push(chunk); }
  } catch (error) { await response.body.cancel().catch(() => {}); throw error; }
  const bytes = verifyFile(Buffer.concat(chunks), pin);
  await mkdir(referenceRoot, { recursive: true, mode: 0o700 }); await assertNoSymlink(filename);
  await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return { referenceRoot, pin };
}

export async function prepareBitSetSources({ sourceRoot, referenceRoot = path.join(REPO, 'out/kotlin-bit-set-reference'), outputRoot }) {
  sourceRoot = path.resolve(sourceRoot); referenceRoot = path.resolve(referenceRoot); outputRoot = path.resolve(outputRoot);
  assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep), 'BitSet output must stay under out/');
  for (const cache of [sourceRoot, referenceRoot]) {
    assert(outputRoot !== cache && !outputRoot.startsWith(cache + path.sep) && !cache.startsWith(outputRoot + path.sep), 'BitSet output overlaps original cache');
  }
  for (const root of [sourceRoot, referenceRoot, outputRoot]) await assertNoSymlink(root);
  const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
  assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'official-wasm-liveness-bit-set-host-port');
  assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
  assert.equal(lock.languageReadiness, false);
  const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json'));
  assert.equal(sha256(closureBytes), lock.primaryClosureSha256);
  const closure = JSON.parse(closureBytes);
  for (const pin of lock.consumers) assert.deepEqual(closure.files.find(item => item.path === pin.path), pin);
  const reference = verifyFile(await readRegular(path.join(referenceRoot, lock.jdk.path)), lock.jdk);
  const portable = verifyFile(await readRegular(path.join(HERE, lock.portable.path)), lock.portable);
  assert(reference.toString().includes('Copyright (c) 1995, 2020, Oracle'));
  assert(portable.toString().includes('Copyright (c) 1995, 2020, Oracle'));
  for (const pin of lock.licenses) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
  const sources = [], commonSources = [], originals = [];
  async function output(name, bytes) {
    const filename = path.join(outputRoot, relativePath(name)); await assertNoSymlink(filename);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    commonSources.push(filename); sources.push({ path: name, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) });
  }
  const preparedConsumers = [];
  for (const pin of lock.consumers) {
    const original = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin);
    const text = original.toString();
    const oldImport = pin.path.endsWith('/BitSetUtil.kt') ? 'import java.util.BitSet' : 'import java.util.*';
    assert.equal(text.split(oldImport).length, 2, 'Selected BitSet import boundary changed');
    const bytes = Buffer.from(text.replace(oldImport, 'import ' + IMPORT));
    assert.equal(bytes.toString().split('\n').filter(line => line.startsWith('import java.')).length, 0);
    await output(pin.path, bytes);
    originals.push({ filename: path.join(sourceRoot, pin.path), pin });
    preparedConsumers.push({ path: pin.path, originalSha256: pin.sha256, bytes: bytes.length, sha256: sha256(bytes), rule: oldImport + ' -> import ' + IMPORT, algorithmBodyChanged: false });
  }
  await output('compiler-port-bit-set/BitSet.kt', portable);
  const receipt = { schemaVersion: 1, kind: 'official-wasm-liveness-bit-set-preparation', source: lock.source,
    sourceLockSha256: sha256(lockBytes), preparationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    inputPaths: { sourceRoot, referenceRoot }, jdk: lock.jdk, portable: lock.portable, licenses: lock.licenses,
    selectedApi: lock.selectedApi, hostAdaptations: lock.hostAdaptations, excludedApi: lock.excludedApi,
    consumers: preparedConsumers, sources, originalSourceUnmodified: true, fullCompilerBuilt: false, languageReadiness: false };
  for (const { filename, pin } of originals) verifyFile(await readRegular(filename), pin);
  verifyFile(await readRegular(path.join(referenceRoot, lock.jdk.path)), lock.jdk);
  const receiptPath = path.join(outputRoot, 'bit-set-inputs.json'); await writeJson(receiptPath, receipt);
  return { receipt, receiptPath, commonSources, replacedOriginalPaths: lock.consumers.map(pin => pin.path) };
}

export async function verifyBitSetPreparation(root) {
  root = path.resolve(root); await assertNoSymlink(root);
  const bytes = await readRegular(path.join(root, 'bit-set-inputs.json')); const receipt = JSON.parse(bytes);
  assert.equal(receipt.kind, 'official-wasm-liveness-bit-set-preparation');
  assert.equal(receipt.sourceLockSha256, sha256(await readRegular(path.join(HERE, 'sources.lock.json'))));
  assert.equal(receipt.preparationToolSha256, sha256(await readRegular(fileURLToPath(import.meta.url))));
  const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
  assert.deepEqual(receipt.source, lock.source);
  for (const key of ['jdk', 'portable', 'licenses', 'selectedApi', 'hostAdaptations', 'excludedApi']) assert.deepEqual(receipt[key], lock[key]);
  assert.equal(receipt.originalSourceUnmodified, true);
  assert.equal(receipt.fullCompilerBuilt, false); assert.equal(receipt.languageReadiness, false);
  assert.deepEqual(receipt.sources.map(pin => pin.path), [...lock.consumers.map(pin => pin.path), 'compiler-port-bit-set/BitSet.kt']);
  assert.deepEqual(receipt.consumers.map(pin => pin.path), lock.consumers.map(pin => pin.path));
  for (const pin of lock.consumers) verifyFile(await readRegular(path.join(receipt.inputPaths.sourceRoot, pin.path)), pin);
  verifyFile(await readRegular(path.join(receipt.inputPaths.referenceRoot, lock.jdk.path)), lock.jdk);
  const commonSources = [];
  for (const pin of receipt.sources) {
    const filename = path.join(root, relativePath(pin.path)); verifyFile(await readRegular(filename), pin); commonSources.push(filename);
  }
  const portable = receipt.sources.find(pin => pin.path === 'compiler-port-bit-set/BitSet.kt');
  assert(portable && portable.sha256 === lock.portable.sha256 && portable.bytes === lock.portable.bytes);
  for (const consumer of receipt.consumers) {
    const pin = lock.consumers.find(item => item.path === consumer.path); assert(pin && consumer.originalSha256 === pin.sha256);
    const original = await readRegular(path.join(receipt.inputPaths.sourceRoot, consumer.path));
    const oldImport = consumer.path.endsWith('/BitSetUtil.kt') ? 'import java.util.BitSet' : 'import java.util.*';
    const expected = Buffer.from(original.toString().replace(oldImport, 'import ' + IMPORT));
    assert.deepEqual(consumer, { path: pin.path, originalSha256: pin.sha256, bytes: expected.length,
      sha256: sha256(expected), rule: oldImport + ' -> import ' + IMPORT, algorithmBodyChanged: false });
    assert.deepEqual(await readRegular(path.join(root, consumer.path)), expected, 'Compiler BitSet consumer body changed');
    assert(consumer.algorithmBodyChanged === false);
  }
  return { receipt, receiptSha256: sha256(bytes), commonSources };
}
