import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareTypeUtilities, verifyTypeUtilitiesPreparation } from './prepare.mjs';
import { typeImplementationDependency } from './build.mjs';
const PREPARED = process.env.KOTLIN_TYPE_UTILITIES_PREPARED;
const options = { skip: PREPARED ? false : 'Set KOTLIN_TYPE_UTILITIES_PREPARED to actual preparation; skip is not acceptance' };
async function withCopy(callback) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kotlin-type-utilities-guard-'));
  try {
    const directory = path.join(temporary, 'prepared'); await cp(PREPARED, directory, { recursive: true });
    const filename = path.join(directory, 'receipt.json'); const receipt = JSON.parse(await readFile(filename));
    for (const [records, folder] of [[receipt.files, 'common'], [receipt.hostFiles, 'host']]) for (const record of records) record.absolutePath = path.join(directory, folder, record.path);
    await writeFile(filename, JSON.stringify(receipt, null, 2) + '\n'); await callback(directory, receipt, temporary);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
test('actual type utilities preparation retains three source bodies and explicit real dependencies', options, async () => {
  const result = await verifyTypeUtilitiesPreparation(PREPARED); assert.equal(result.sourceFiles.length, 3); assert.equal(result.replacedOriginalPaths.length, 3);
  assert.equal(result.hostDependencyFiles.length, 1); assert.equal(result.receipt.readiness, false); assert.equal(result.receipt.requiredConcreteDependencies.length, 2);
  assert(result.receipt.sourceApiAdjustments.some(item => item.method === 'TypeUtils.substituteProjectionsForParameters'));
});
test('tampered original source fails before any preparation publication', options, async () => withCopy(async (directory, receipt, temporary) => {
  const filename = path.join(directory, 'sources', receipt.replacedOriginalPaths[0]); await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\nchanged\n')]));
  await assert.rejects(verifyTypeUtilitiesPreparation(directory), /Pinned source content mismatch/);
  await assert.rejects(prepareTypeUtilities(path.join(directory, 'sources'), path.join(temporary, 'attempt')));
  await assert.rejects(readFile(path.join(temporary, 'attempt/receipt.json')), { code: 'ENOENT' });
}));
test('all three actual algorithm ports and shared assertion are sealed', options, async () => {
  for (const name of ['common/TypeUtils.kt', 'common/TypeCheckingProcedure.kt', 'common/TypeCheckerProcedureCallbacksImpl.kt', 'host/assertions/CompilerAssertions.kt']) await withCopy(async directory => {
    const filename = path.join(directory, name); await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\nchanged\n')])); await assert.rejects(verifyTypeUtilitiesPreparation(directory), /prepared source changed/);
  });
});
test('missing file and symlink inputs are rejected', options, async () => {
  await withCopy(async directory => { await rm(path.join(directory, 'common/TypeUtils.kt')); await assert.rejects(verifyTypeUtilitiesPreparation(directory)); });
  await withCopy(async directory => {
    const filename = path.join(directory, 'common/TypeCheckingProcedure.kt'); const redirect = path.join(directory, 'redirect.kt');
    await writeFile(redirect, await readFile(filename)); await rm(filename); await symlink(redirect, filename); await assert.rejects(verifyTypeUtilitiesPreparation(directory), /Symlink paths/);
  });
});
test('wrong, duplicate, traversal and incomplete source indices fail', options, async () => {
  for (const mutate of [receipt => receipt.files[0].path = '../outside.kt', receipt => receipt.files[0] = receipt.files[1], receipt => receipt.files.pop(), receipt => receipt.hostFiles = []]) await withCopy(async (directory, receipt) => {
    mutate(receipt); await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt)); await assert.rejects(verifyTypeUtilitiesPreparation(directory));
  });
});
test('nullable API decisions, source identity, previous source unit and readiness cannot be relabeled', options, async () => {
  for (const mutate of [receipt => receipt.source.commit = '0'.repeat(40), receipt => receipt.readiness = true, receipt => receipt.browserCompilerBuilt = true,
    receipt => receipt.sourceApiAdjustments = [], receipt => receipt.previousSourceLockSha256 = '0'.repeat(64), receipt => receipt.requiredConcreteDependencies = []]) await withCopy(async (directory, receipt) => {
    mutate(receipt); await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt)); await assert.rejects(verifyTypeUtilitiesPreparation(directory), /Stale type utilities preparation/);
  });
});
test('existing preparation and receipt bytes are retained after rejected repeat', options, async () => withCopy(async (directory, receipt) => {
  const filename = path.join(directory, 'receipt.json'); const bytes = await readFile(filename);
  await assert.rejects(prepareTypeUtilities(path.join(directory, 'sources'), directory), { code: 'EEXIST' }); assert.deepEqual(await readFile(filename), bytes);
}));
test('two real preparations reproduce source and host identities', options, async () => withCopy(async (directory, receipt, temporary) => {
  const first = await prepareTypeUtilities(path.join(directory, 'sources'), path.join(temporary, 'first')); const second = await prepareTypeUtilities(path.join(directory, 'sources'), path.join(temporary, 'second'));
  for (const field of ['originals', 'sourceLockSha256', 'sourceApiAdjustments', 'previousSourceLockSha256', 'requiredConcreteDependencies']) assert.deepEqual(first.receipt[field], second.receipt[field]);
  assert.deepEqual(first.receipt.files.map(({ absolutePath, ...record }) => record), second.receipt.files.map(({ absolutePath, ...record }) => record));
}));
test('actual substitution SCC dependency cannot be omitted', async () => { await assert.rejects(typeImplementationDependency(), /Actual prepared and built type implementation dependency required/); });
