#!/usr/bin/env node
/** Pin-checked UTF-8 host binding; official writer algorithms are unchanged. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { generateCompilerUtf8, UTF8_REPLACEMENTS } from './generate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRITERS = ['WasmIrToBinary.kt', 'WasmIrToText.kt'].map(name => 'wasm/wasm.ir/src/org/jetbrains/kotlin/wasm/ir/convertors/' + name);
const IMPORT = 'import org.jetbrains.kotlin.portable.text.compilerUtf8Bytes as toByteArray';
const MARKER = 'package org.jetbrains.kotlin.wasm.ir.convertors\n';

async function inputs(sourceRoot) {
  sourceRoot = path.resolve(sourceRoot); await assertNoSymlink(sourceRoot);
  const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
  assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'official-wasm-writer-utf8-common-boundary');
  assert.deepEqual(lock.source, { repository: 'https://github.com/JetBrains/kotlin.git', commit: '4d78aae1e337cd40f69baa865aed950fe807a775', treeSha: '2be662d1ae06bfcf435efbe18191ba5e1e3f035e' });
  assert.deepEqual(lock.writers.map(pin => pin.path), WRITERS); assert.equal(lock.writerImport, IMPORT);
  assert.equal(lock.algorithm.path, 'libraries/stdlib/wasm/src/kotlin/text/utf8Encoding.kt');
  assert.equal(lock.languageReadiness, false); assert.equal(lock.stdlibReferences.length, 8);
  assert.equal(sha256(await readRegular(path.join(HERE, 'generate.mjs'))), lock.generator.sha256);
  assert.deepEqual(lock.replacements, UTF8_REPLACEMENTS);
  const algorithmOriginal = verifyFile(await readRegular(path.join(HERE, 'upstream/utf8Encoding.kt')), lock.algorithm);
  const algorithm = generateCompilerUtf8(algorithmOriginal); const api = await readRegular(path.join(HERE, 'CompilerUtf8Api.kt'));
  for (const [pin, bytes] of [[lock.generatedAlgorithm, algorithm], [lock.api, api]]) {
    assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'UTF-8 common input changed');
  }
  const writers = [];
  for (const pin of lock.writers) {
    relativePath(pin.path); const original = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin);
    const text = original.toString('utf8'); assert.equal(text.split(MARKER).length, 2); assert(!text.includes(IMPORT));
    const portable = Buffer.from(text.replace(MARKER, MARKER + '\n' + IMPORT + '\n'));
    assert.equal(portable.length, pin.portableBytes); assert.equal(sha256(portable), pin.portableSha256);
    writers.push({ pin, original, portable });
  }
  return { sourceRoot, lock, lockBytes, algorithmOriginal, algorithm, api, writers };
}

function receiptFor(root, input, toolSha256) {
  const files = [...input.writers.map(({ pin, portable }) => ({ path: pin.path, bytes: portable.length, sha256: sha256(portable), originalSha256: pin.sha256 })),
    { ...input.lock.generatedAlgorithm, originalSha256: input.lock.algorithm.sha256 }, { ...input.lock.api, originalSha256: null }];
  return { schemaVersion: 1, kind: 'official-wasm-writer-utf8-common-preparation', source: input.lock.source,
    sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: toolSha256, generator: input.lock.generator,
    algorithm: input.lock.algorithm, stdlibReferences: input.lock.stdlibReferences, replacements: UTF8_REPLACEMENTS,
    writers: input.lock.writers, writerImport: IMPORT, files, commonSources: files.map(pin => path.join(root, pin.path)), replacedOriginalPaths: WRITERS,
    writerAlgorithms: 'unchanged; only explicit extension imports inserted', malformedUtf16Encoding: 'one ASCII 0x3f per unpaired UTF-16 surrogate',
    malformedUtf8Decoding: 'JVM replacement grouping or typed strict rejection; no normalization',
    decoderCallerIntegration: 'WasmBinaryToIR stream/ByteBuffer boundary remains separate; use compilerUtf8String(throwOnInvalidSequence=true)',
    originalSourceUnmodified: true, browserCompilerBuilt: false, languageReadiness: false };
}

export async function prepareCompilerTextSources({ sourceRoot, outputRoot }) {
  const input = await inputs(sourceRoot); outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot);
  if (outputRoot === input.sourceRoot || outputRoot.startsWith(input.sourceRoot + path.sep) || input.sourceRoot.startsWith(outputRoot + path.sep)) throw new Error('Text output overlaps original source');
  const root = path.join(outputRoot, 'compiler-port-text'); await assertNoSymlink(root);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 }); await mkdir(root, { recursive: false, mode: 0o700 });
  for (const { pin, original, portable } of input.writers) {
    for (const [prefix, bytes] of [['original', original], ['', portable]]) {
      const filename = path.join(root, prefix, pin.path); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    }
  }
  for (const [pin, bytes] of [[input.lock.generatedAlgorithm, input.algorithm], [input.lock.api, input.api]]) {
    const filename = path.join(root, relativePath(pin.path)); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
  }
  const receipt = receiptFor(root, input, sha256(await readRegular(fileURLToPath(import.meta.url)))); const receiptPath = path.join(root, 'receipt.json');
  await writeJson(receiptPath, receipt); return { commonSources: receipt.commonSources, replacedOriginalPaths: WRITERS, receipt, receiptPath };
}

export async function verifyCompilerTextPreparation(root) {
  root = path.resolve(root); await assertNoSymlink(root);
  const receiptBytes = await readRegular(path.join(root, 'receipt.json')); const receipt = JSON.parse(receiptBytes);
  const input = await inputs(path.join(root, 'original'));
  assert.deepEqual(receipt, receiptFor(root, input, sha256(await readRegular(fileURLToPath(import.meta.url)))), 'Stale compiler text preparation');
  for (const pin of receipt.files) {
    const bytes = await readRegular(path.join(root, relativePath(pin.path))); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Prepared UTF-8 source changed');
  }
  return { root, receipt, receiptSha256: sha256(receiptBytes), commonSources: receipt.commonSources, replacedOriginalPaths: WRITERS };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--');
  if (args.length !== 4 || args[0] !== '--source-root' || args[2] !== '--output') throw new Error('Usage: prepare.mjs --source-root PINNED_SOURCES --output NEW_DIRECTORY');
  const result = await prepareCompilerTextSources({ sourceRoot: args[1], outputRoot: args[3] }); console.log(JSON.stringify({ receiptPath: result.receiptPath, commonSources: result.commonSources.length }));
}
