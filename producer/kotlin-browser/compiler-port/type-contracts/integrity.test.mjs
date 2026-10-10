import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { verifyTypePreparation } from './prepare.mjs';
const PREPARED = process.env.KOTLIN_TYPE_CONTRACTS_PREPARED;
const options = { skip: PREPARED ? false : 'Set KOTLIN_TYPE_CONTRACTS_PREPARED to actual preparation; skip is not acceptance' };
async function withCopy(callback) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kotlin-type-contracts-guard-'));
  try {
    const directory = path.join(temporary, 'prepared'); await cp(PREPARED, directory, { recursive: true });
    const file = path.join(directory, 'receipt.json'); const receipt = JSON.parse(await readFile(file));
    for (const record of receipt.files) record.absolutePath = path.join(directory, 'generated', record.path);
    await writeFile(file, JSON.stringify(receipt, null, 2) + '\n'); await callback(directory, receipt);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
test('real type preparation provides ten bounded common inputs', options, async () => {
  const result = await verifyTypePreparation(PREPARED); assert.equal(result.sourceFiles.length, 10); assert.equal(result.receipt.interfaces, 10);
  assert.equal(result.receipt.typeCheckingAlgorithmsPorted, false); assert.equal(result.replacedOriginalPaths.length, 9);
});
test('changed original source, generated source, AST and own tools fail', options, async () => {
  for (const filename of ['sources/core/descriptors/src/org/jetbrains/kotlin/types/TypeProjection.java', 'generated/ReceiverValue.kt', 'ast.json', 'generate.py', 'TypeContractAst.java']) await withCopy(async directory => {
    const file = path.join(directory, filename); await writeFile(file, Buffer.concat([await readFile(file), Buffer.from('\nchanged\n')])); await assert.rejects(verifyTypePreparation(directory));
  });
});
test('frozen base generator tampering fails', options, async () => withCopy(async directory => {
  await writeFile(path.join(directory, 'base/generate.py'), '# replaced\n'); await assert.rejects(verifyTypePreparation(directory), /Frozen base tool changed/);
}));
test('missing file and symlink injection fail', options, async () => {
  await withCopy(async directory => { await rm(path.join(directory, 'generated/TypeConstructor.kt')); await assert.rejects(verifyTypePreparation(directory)); });
  await withCopy(async directory => {
    const file = path.join(directory, 'generated/TypeConstructor.kt'); const moved = path.join(directory, 'redirect.kt');
    await writeFile(moved, await readFile(file)); await rm(file); await symlink(moved, file); await assert.rejects(verifyTypePreparation(directory), /Symlink paths/);
  });
});
test('traversal and incomplete generation indices fail', options, async () => {
  for (const change of [receipt => receipt.files[0].path = '../escape.kt', receipt => receipt.files.pop()]) await withCopy(async (directory, receipt) => {
    change(receipt); await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt)); await assert.rejects(verifyTypePreparation(directory));
  });
});
test('source identity, readiness and real-algorithm status cannot be relaxed', options, async () => {
  for (const change of [receipt => receipt.source.commit = '0'.repeat(40), receipt => receipt.readiness = true, receipt => receipt.typeCheckingAlgorithmsPorted = true]) await withCopy(async (directory, receipt) => {
    change(receipt); await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt)); await assert.rejects(verifyTypePreparation(directory), /Stale type contract preparation/);
  });
});
