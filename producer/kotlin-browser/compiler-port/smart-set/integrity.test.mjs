import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareSmartSetSources, verifySmartSetPreparation } from './prepare.mjs';

const PREPARED = process.env.KOTLIN_SMART_SET_PREPARED;
const options = { skip: PREPARED ? false : 'Set KOTLIN_SMART_SET_PREPARED to actual source preparation; skip is not acceptance' };
async function withCopy(callback) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kotlin-smart-set-guard-'));
  try {
    const root = path.join(temporary, 'output/compiler-port-smart-set'); await cp(PREPARED, root, { recursive: true });
    const filename = path.join(root, 'receipt.json'); const receipt = JSON.parse(await readFile(filename));
    receipt.commonSources = ['SmartSet.kt', 'SmartSetHost.kt'].map(name => path.join(root, name));
    await writeFile(filename, JSON.stringify(receipt, null, 2) + '\n'); await callback(root, receipt, temporary);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

test('actual source body has exactly two mechanical host bindings and false readiness', options, async () => {
  const prepared = await verifySmartSetPreparation(PREPARED); assert.equal(prepared.commonSources.length, 2); assert.equal(prepared.replacedOriginalPaths.length, 1);
  assert.equal(prepared.receipt.languageReadiness, false); assert.equal(prepared.receipt.browserCompilerBuilt, false);
  assert.equal(prepared.receipt.stdlibSourceProvenance.length, 9); const original = await readFile(path.join(PREPARED, 'original', prepared.receipt.original.path), 'utf8');
  let common = original; for (const { from, to } of prepared.receipt.replacements) { assert.equal(common.split(from).length, 2); common = common.replace(from, to); }
  assert.equal(await readFile(path.join(PREPARED, 'SmartSet.kt'), 'utf8'), common);
  assert(common.includes('(data as MutableSet<T>).iterator()') && common.includes('size++'));
});
test('tampered original fails before output publication', options, async () => withCopy(async (root, receipt, temporary) => {
  const filename = path.join(root, 'original', receipt.original.path); await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\nchanged\n')]));
  await assert.rejects(verifySmartSetPreparation(root), /Pinned source content mismatch/);
  const outputRoot = path.join(temporary, 'attempt'); await assert.rejects(prepareSmartSetSources({ sourceRoot: path.join(root, 'original'), outputRoot }));
  await assert.rejects(readFile(path.join(outputRoot, 'compiler-port-smart-set/receipt.json')), { code: 'ENOENT' });
}));
test('both prepared source and empty iterator host bytes are sealed', options, async () => {
  for (const name of ['SmartSet.kt', 'SmartSetHost.kt']) await withCopy(async root => {
    const filename = path.join(root, name); await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\nchanged\n')]));
    await assert.rejects(verifySmartSetPreparation(root), /Prepared SmartSet input changed/);
  });
});
test('missing and symlink source inputs are rejected', options, async () => {
  await withCopy(async root => { await rm(path.join(root, 'SmartSet.kt')); await assert.rejects(verifySmartSetPreparation(root)); });
  await withCopy(async (root, receipt, temporary) => {
    const filename = path.join(root, 'original', receipt.original.path); const redirected = path.join(temporary, 'redirected.kt');
    await writeFile(redirected, await readFile(filename)); await rm(filename); await symlink(redirected, filename); await assert.rejects(verifySmartSetPreparation(root), /Symlink paths/);
  });
});
test('source, replacement, helper, profile and readiness records cannot be relabeled', options, async () => {
  for (const mutate of [r => r.source.commit = '0'.repeat(40), r => r.portable.sha256 = '0'.repeat(64), r => r.host.sha256 = '0'.repeat(64),
    r => r.replacements = [], r => r.sourceBody = 'invented algorithm', r => r.browserCompilerBuilt = true, r => r.languageReadiness = true,
    r => r.upstreamTestDiscovery.status = 'conformance passed']) await withCopy(async (root, receipt) => {
    mutate(receipt); await writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt)); await assert.rejects(verifySmartSetPreparation(root), /Stale SmartSet preparation/);
  });
});
test('wrong, duplicate and incomplete prepared indices fail', options, async () => {
  for (const mutate of [r => r.commonSources[0] = '../outside.kt', r => r.commonSources[1] = r.commonSources[0], r => r.commonSources.pop(),
    r => r.replacedOriginalPaths = []]) await withCopy(async (root, receipt) => {
    mutate(receipt); await writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt)); await assert.rejects(verifySmartSetPreparation(root), /Stale SmartSet preparation/);
  });
});
test('existing prepared sources and evidence remain unchanged after rejected repeat', options, async () => withCopy(async (root, receipt, temporary) => {
  const names = ['receipt.json', 'SmartSet.kt', 'SmartSetHost.kt']; const before = await Promise.all(names.map(name => readFile(path.join(root, name))));
  const sourceRoot = path.join(temporary, 'reference-source'); await cp(path.join(root, 'original'), sourceRoot, { recursive: true });
  await assert.rejects(prepareSmartSetSources({ sourceRoot, outputRoot: path.dirname(root) }), { code: 'EEXIST' });
  for (let i = 0; i < names.length; ++i) assert.deepEqual(await readFile(path.join(root, names[i])), before[i]);
}));
test('source/output overlap and output symlink paths are rejected', options, async () => withCopy(async (root, receipt, temporary) => {
  const sourceRoot = path.join(root, 'original'); await assert.rejects(prepareSmartSetSources({ sourceRoot, outputRoot: path.join(sourceRoot, 'inside') }), /overlaps original source/);
  const outputRoot = path.join(temporary, 'redirect'); await symlink(path.dirname(root), outputRoot); await assert.rejects(prepareSmartSetSources({ sourceRoot, outputRoot }), /Symlink paths/);
}));
test('two real preparations reproduce original and portable identities', options, async () => withCopy(async (root, receipt, temporary) => {
  const sourceRoot = path.join(root, 'original'); const first = await prepareSmartSetSources({ sourceRoot, outputRoot: path.join(temporary, 'one') });
  const second = await prepareSmartSetSources({ sourceRoot, outputRoot: path.join(temporary, 'two') });
  for (const field of ['source', 'sourceLockSha256', 'original', 'portable', 'host', 'replacements', 'stdlibSourceProvenance']) assert.deepEqual(first.receipt[field], second.receipt[field]);
  for (let i = 0; i < first.commonSources.length; ++i) assert.deepEqual(await readFile(first.commonSources[i]), await readFile(second.commonSources[i]));
}));
