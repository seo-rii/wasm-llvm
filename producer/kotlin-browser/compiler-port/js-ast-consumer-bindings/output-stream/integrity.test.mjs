import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareJsAstOutputStream, verifyJsAstOutputStream, OUTPUT } from './prepare.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
async function fresh() {
  const parent = path.join(REPO, 'out/kotlin-js-ast-output-stream-guards'); await mkdir(parent, { recursive: true });
  const outputRoot = await mkdtemp(path.join(parent, 'run-'));
  const prepared = await prepareJsAstOutputStream({ sourceRoot, outputRoot });
  return { sourceRoot, outputRoot, receiptPath: prepared.receiptPath };
}
test('canonical output and receipt replay', async () => { await verifyJsAstOutputStream(await fresh()); });
test('implementation output mutation rejected', async () => {
  const options = await fresh(); await writeFile(path.join(options.outputRoot, OUTPUT), 'mutation');
  await assert.rejects(verifyJsAstOutputStream(options));
});
test('receipt mutation rejected', async () => {
  const options = await fresh(), receipt = JSON.parse(await readFile(options.receiptPath));
  receipt.languageReadiness = true; await writeFile(options.receiptPath, JSON.stringify(receipt));
  await assert.rejects(verifyJsAstOutputStream(options));
});
test('existing output remains untouched', async () => {
  const options = await fresh(), before = await readFile(path.join(options.outputRoot, OUTPUT));
  await assert.rejects(prepareJsAstOutputStream(options)); assert.deepEqual(await readFile(path.join(options.outputRoot, OUTPUT)), before);
});
test('source and output overlap rejected', async () => { await assert.rejects(prepareJsAstOutputStream({ sourceRoot, outputRoot: sourceRoot })); });
test('symlink output rejected', async () => {
  const options = await fresh(), alias = options.outputRoot + '-alias'; await symlink(options.outputRoot, alias);
  await assert.rejects(prepareJsAstOutputStream({ sourceRoot, outputRoot: alias }));
});
