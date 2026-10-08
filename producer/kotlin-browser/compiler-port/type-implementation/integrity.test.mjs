import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareTypeImplementations, verifyTypeImplementationPreparation } from './prepare.mjs';
const PREPARED = process.env.KOTLIN_TYPE_IMPLEMENTATION_PREPARED;
const options = { skip: PREPARED ? false : 'Set KOTLIN_TYPE_IMPLEMENTATION_PREPARED to actual preparation; skip is not acceptance' };
async function withCopy(callback) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kotlin-type-implementation-guard-'));
  try {
    const directory = path.join(temporary, 'prepared'); await cp(PREPARED, directory, { recursive: true });
    const filename = path.join(directory, 'receipt.json'); const receipt = JSON.parse(await readFile(filename));
    for (const [records, folder] of [[receipt.files, 'common'], [receipt.hostFiles, 'host']]) for (const record of records) record.absolutePath = path.join(directory, folder, record.path);
    await writeFile(filename, JSON.stringify(receipt, null, 2) + '\n'); await callback(directory, receipt, temporary);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
test('actual preparation includes three real algorithms and typed alias without compiler readiness', options, async () => {
  const result = await verifyTypeImplementationPreparation(PREPARED);
  assert.equal(result.sourceFiles.length, 4); assert.equal(result.replacedOriginalPaths.length, 3); assert.equal(result.hostDependencyFiles.length, 3);
  assert.equal(result.receipt.readiness, false); assert.equal(result.receipt.requiredConcreteDependencies.length, 2);
});
test('original body tampering fails before publishing any output', options, async () => withCopy(async (directory, receipt, temporary) => {
  const filename = path.join(directory, 'sources', receipt.algorithms[0]); await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\nchanged\n')]));
  await assert.rejects(verifyTypeImplementationPreparation(directory), /source mismatch/);
  await assert.rejects(prepareTypeImplementations(path.join(directory, 'sources'), path.join(temporary, 'attempt')), /source mismatch/);
  await assert.rejects(readFile(path.join(temporary, 'attempt/receipt.json')), { code: 'ENOENT' });
}));
test('portable algorithm and shared assertion/cancellation bytes cannot change', options, async () => {
  for (const filename of ['common/TypeSubstitutor.kt', 'common/TypeProjectionBase.kt', 'common/TypeProjectionImpl.kt', 'host/assertions/CompilerAssertions.kt', 'host/storage/exceptionUtils.kt']) await withCopy(async directory => {
    const target = path.join(directory, filename); await writeFile(target, Buffer.concat([await readFile(target), Buffer.from('\nchanged\n')]));
    await assert.rejects(verifyTypeImplementationPreparation(directory), /Prepared type implementation changed/);
  });
});
test('missing sources and symlink substitution fail', options, async () => {
  await withCopy(async directory => { await rm(path.join(directory, 'common/TypeProjectionBase.kt')); await assert.rejects(verifyTypeImplementationPreparation(directory)); });
  await withCopy(async directory => {
    const filename = path.join(directory, 'common/TypeProjectionImpl.kt'); const redirected = path.join(directory, 'redirect.kt');
    await writeFile(redirected, await readFile(filename)); await rm(filename); await symlink(redirected, filename);
    await assert.rejects(verifyTypeImplementationPreparation(directory), /Symlink paths/);
  });
});
test('traversal, duplicate or incomplete algorithm indices cannot be accepted', options, async () => {
  for (const mutate of [receipt => receipt.files[0].path = '../outside.kt', receipt => receipt.files[0] = receipt.files[1], receipt => receipt.files.pop(), receipt => receipt.hostFiles.pop()]) await withCopy(async (directory, receipt) => {
    mutate(receipt); await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt)); await assert.rejects(verifyTypeImplementationPreparation(directory));
  });
});
test('source identity, preservation claims and readiness are sealed', options, async () => {
  for (const mutate of [receipt => receipt.source.commit = '0'.repeat(40), receipt => receipt.source.treeSha = '0'.repeat(40), receipt => receipt.readiness = true,
    receipt => receipt.browserCompilerBuilt = true, receipt => receipt.requiredConcreteDependencies = [], receipt => receipt.preservation = [], receipt => receipt.privateFieldRenames = {}]) await withCopy(async (directory, receipt) => {
    mutate(receipt); await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt)); await assert.rejects(verifyTypeImplementationPreparation(directory), /Stale type implementation preparation/);
  });
});
test('existing evidence directory is preserved when repeated preparation is rejected', options, async () => withCopy(async (directory, receipt, temporary) => {
  const filename = path.join(directory, 'receipt.json'); const original = await readFile(filename);
  await assert.rejects(prepareTypeImplementations(path.join(directory, 'sources'), directory), { code: 'EEXIST' });
  assert.deepEqual(await readFile(filename), original);
}));
test('two genuine preparations have identical bounded source and host identities', options, async () => withCopy(async (directory, receipt, temporary) => {
  const first = await prepareTypeImplementations(path.join(directory, 'sources'), path.join(temporary, 'first'));
  const second = await prepareTypeImplementations(path.join(directory, 'sources'), path.join(temporary, 'second'));
  for (const field of ['originals', 'algorithms', 'sourceLockSha256', 'preparationToolSha256', 'requiredConcreteDependencies']) assert.deepEqual(first.receipt[field], second.receipt[field]);
  assert.deepEqual(first.receipt.files.map(({ absolutePath, ...record }) => record), second.receipt.files.map(({ absolutePath, ...record }) => record));
  assert.deepEqual(first.receipt.hostFiles.map(({ absolutePath, ...record }) => record), second.receipt.hostFiles.map(({ absolutePath, ...record }) => record));
}));
