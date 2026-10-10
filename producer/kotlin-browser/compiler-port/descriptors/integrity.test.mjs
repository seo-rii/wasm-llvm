import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { verifyDescriptorPreparation, loadDescriptorSources } from './prepare.mjs';
import { writeJson } from '../../scripts/source.mjs';

const PREPARED = process.env.KOTLIN_DESCRIPTOR_PREPARED;
async function withCopy(callback) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kotlin-descriptor-guard-'));
  try {
    const directory = path.join(temporary, 'prepared'); await cp(PREPARED, directory, { recursive: true });
    const receiptPath = path.join(directory, 'receipt.json'); const receipt = JSON.parse(await readFile(receiptPath));
    for (const record of receipt.files) record.absolutePath = path.join(directory, 'generated', record.path);
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    await callback(directory, receipt);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
const options = { skip: PREPARED ? false : 'Set KOTLIN_DESCRIPTOR_PREPARED to a real preparation; skip is not acceptance' };

test('sealed real descriptor preparation verifies', options, async () => {
  const result = await verifyDescriptorPreparation(PREPARED);
  assert.equal(result.sourceFiles.length, 29);
  assert.equal(result.receipt.interfaces, 30);
  assert.equal(result.receipt.readiness, false);
});
test('tampered actual original source pin fails', options, async () => withCopy(async directory => {
  const original = path.join(directory, 'sources/core/descriptors/src/org/jetbrains/kotlin/descriptors/Named.java');
  await writeFile(original, Buffer.concat([await readFile(original), Buffer.from('\n// changed\n')]));
  await assert.rejects(loadDescriptorSources(path.join(directory, 'sources')), /Descriptor source mismatch/);
}));
test('changed generated contract fails', options, async () => withCopy(async directory => {
  await writeFile(path.join(directory, 'generated/Named.kt'), 'interface Named {}');
  await assert.rejects(verifyDescriptorPreparation(directory), /Descriptor generated source changed/);
}));
test('changed AST, generator or source lock fails', options, async () => {
  for (const name of ['ast.json', 'generate.py', 'DescriptorAst.java', 'sources.lock.json']) await withCopy(async directory => {
    const file = path.join(directory, name); await writeFile(file, Buffer.concat([await readFile(file), Buffer.from('\nchanged\n')]));
    await assert.rejects(verifyDescriptorPreparation(directory), /Stale descriptor preparation|Descriptor generator changed/);
  });
});
test('traversal or duplicate generated paths fail', options, async () => {
  for (const filePath of ['../Named.kt', 'Named.kt']) await withCopy(async (directory, receipt) => {
    receipt.files[0].path = filePath;
    await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt));
    await assert.rejects(verifyDescriptorPreparation(directory));
  });
});
test('missing generated source and injected symlink fail', options, async () => {
  await withCopy(async directory => {
    const file = path.join(directory, 'generated/Named.kt'); await rm(file);
    await assert.rejects(verifyDescriptorPreparation(directory));
  });
  await withCopy(async directory => {
    const file = path.join(directory, 'generated/Named.kt'); const target = path.join(directory, 'Named-redirect.kt');
    await writeFile(target, await readFile(file)); await rm(file); await symlink(target, file);
    await assert.rejects(verifyDescriptorPreparation(directory), /Symlink paths/);
  });
});
test('source identity and readiness cannot be relaxed', options, async () => {
  for (const change of [receipt => receipt.source.commit = '0'.repeat(40), receipt => receipt.readiness = true, receipt => receipt.concreteImplementationsPorted = true]) await withCopy(async (directory, receipt) => {
    change(receipt); await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt));
    await assert.rejects(verifyDescriptorPreparation(directory), /Stale descriptor preparation|Descriptor source identity mismatch/);
  });
});
test('existing evidence is preserved when publication fails', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kotlin-descriptor-evidence-'));
  try {
    const file = path.join(temporary, 'receipt.json'); const original = Buffer.from('{"original":true}\n');
    await writeFile(file, original, { flag: 'wx' }); await assert.rejects(writeJson(file, { original: false }));
    assert.deepEqual(await readFile(file), original);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
