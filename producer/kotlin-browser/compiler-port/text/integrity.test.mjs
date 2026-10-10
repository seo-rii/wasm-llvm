import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareCompilerTextSources, verifyCompilerTextPreparation } from './prepare.mjs';

const PREPARED = process.env.KOTLIN_TEXT_PREPARED;
const options = { skip: PREPARED ? false : 'Set KOTLIN_TEXT_PREPARED to actual pinned preparation; skip is not acceptance' };
async function withCopy(callback) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kotlin-text-guard-'));
  try {
    const root = path.join(temporary, 'output/compiler-port-text'); await cp(PREPARED, root, { recursive: true });
    const filename = path.join(root, 'receipt.json'); const receipt = JSON.parse(await readFile(filename));
    receipt.commonSources = receipt.files.map(pin => path.join(root, pin.path));
    await writeFile(filename, JSON.stringify(receipt, null, 2) + '\n'); await callback(root, receipt, temporary);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

test('actual writer bodies differ only by their explicit UTF-8 imports', options, async () => {
  const prepared = await verifyCompilerTextPreparation(PREPARED);
  assert.equal(prepared.commonSources.length, 4); assert.equal(prepared.replacedOriginalPaths.length, 2);
  assert.equal(prepared.receipt.languageReadiness, false); assert.equal(prepared.receipt.browserCompilerBuilt, false);
  for (const pin of prepared.receipt.writers) {
    const original = await readFile(path.join(PREPARED, 'original', pin.path), 'utf8');
    const expected = original.replace('package org.jetbrains.kotlin.wasm.ir.convertors\n', 'package org.jetbrains.kotlin.wasm.ir.convertors\n\n' + prepared.receipt.writerImport + '\n');
    assert.equal(await readFile(path.join(PREPARED, pin.path), 'utf8'), expected);
  }
});
test('tampered original fails before publication', options, async () => withCopy(async (root, receipt, temporary) => {
  const filename = path.join(root, 'original', receipt.writers[0].path); await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\nchanged\n')]));
  await assert.rejects(verifyCompilerTextPreparation(root), /Pinned source content mismatch/);
  const outputRoot = path.join(temporary, 'attempt'); await assert.rejects(prepareCompilerTextSources({ sourceRoot: path.join(root, 'original'), outputRoot }));
  await assert.rejects(readFile(path.join(outputRoot, 'compiler-port-text/receipt.json')), { code: 'ENOENT' });
}));
test('both writer sources and both UTF-8 helper sources are sealed', options, async () => {
  const prepared = await verifyCompilerTextPreparation(PREPARED);
  for (const pin of prepared.receipt.files) await withCopy(async root => {
    const filename = path.join(root, pin.path); await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\nchanged\n')]));
    await assert.rejects(verifyCompilerTextPreparation(root), { code: 'ERR_ASSERTION' });
  });
});
test('missing and symlink input/output paths are rejected', options, async () => {
  await withCopy(async root => { await rm(path.join(root, 'CompilerUtf8Api.kt')); await assert.rejects(verifyCompilerTextPreparation(root)); });
  await withCopy(async (root, receipt, temporary) => {
    const filename = path.join(root, 'original', receipt.writers[0].path); const redirect = path.join(temporary, 'redirected.kt');
    await writeFile(redirect, await readFile(filename)); await rm(filename); await symlink(redirect, filename);
    await assert.rejects(verifyCompilerTextPreparation(root), /Symlink paths/);
  });
});
test('compiler pin, host behavior, source correspondence and readiness cannot be relabeled', options, async () => {
  for (const mutate of [r => r.source.commit = '0'.repeat(40), r => r.algorithm.sha256 = '0'.repeat(64), r => r.replacements = [],
    r => r.writerAlgorithms = 'replacement emitter', r => r.malformedUtf16Encoding = 'U+FFFD', r => r.decoderCallerIntegration = 'whole reader supported',
    r => r.browserCompilerBuilt = true, r => r.languageReadiness = true]) await withCopy(async (root, receipt) => {
    mutate(receipt); await writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt));
    await assert.rejects(verifyCompilerTextPreparation(root), /Stale compiler text preparation/);
  });
});
test('wrong, duplicate and missing source indexes are rejected', options, async () => {
  for (const mutate of [r => r.commonSources[0] = '../outside.kt', r => r.commonSources[1] = r.commonSources[0], r => r.commonSources.pop(),
    r => r.files.pop(), r => r.replacedOriginalPaths = []]) await withCopy(async (root, receipt) => {
    mutate(receipt); await writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt));
    await assert.rejects(verifyCompilerTextPreparation(root), /Stale compiler text preparation/);
  });
});
test('existing evidence and source bytes survive rejected repeat preparation', options, async () => withCopy(async (root, receipt, temporary) => {
  const names = ['receipt.json', ...receipt.files.map(pin => pin.path)]; const before = await Promise.all(names.map(name => readFile(path.join(root, name))));
  const sourceRoot = path.join(temporary, 'source'); await cp(path.join(root, 'original'), sourceRoot, { recursive: true });
  await assert.rejects(prepareCompilerTextSources({ sourceRoot, outputRoot: path.dirname(root) }), { code: 'EEXIST' });
  for (let i = 0; i < names.length; ++i) assert.deepEqual(await readFile(path.join(root, names[i])), before[i]);
}));
test('source/output overlap and output symlink ancestors are rejected', options, async () => withCopy(async (root, receipt, temporary) => {
  const sourceRoot = path.join(root, 'original');
  await assert.rejects(prepareCompilerTextSources({ sourceRoot, outputRoot: path.join(sourceRoot, 'inside') }), /overlaps original source/);
  const outputRoot = path.join(temporary, 'redirect'); await symlink(path.dirname(root), outputRoot);
  await assert.rejects(prepareCompilerTextSources({ sourceRoot, outputRoot }), /Symlink paths/);
}));
test('two actual preparations reproduce all source and behavior identities', options, async () => withCopy(async (root, receipt, temporary) => {
  const sourceRoot = path.join(root, 'original'); const first = await prepareCompilerTextSources({ sourceRoot, outputRoot: path.join(temporary, 'one') });
  const second = await prepareCompilerTextSources({ sourceRoot, outputRoot: path.join(temporary, 'two') });
  for (const field of ['source', 'sourceLockSha256', 'algorithm', 'generator', 'replacements', 'writers', 'files', 'writerImport', 'stdlibReferences']) assert.deepEqual(first.receipt[field], second.receipt[field]);
  for (let i = 0; i < first.commonSources.length; ++i) assert.deepEqual(await readFile(first.commonSources[i]), await readFile(second.commonSources[i]));
}));
