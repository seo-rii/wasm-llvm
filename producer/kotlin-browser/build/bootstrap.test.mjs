import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { inspectWasm } from './baseline.mjs';
import { loadBootstrapLock, verifyArtifact } from './bootstrap.mjs';
import { sha256 } from '../scripts/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('bootstrap artifact verification rejects tampered bytes and symlink substitutions', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kotlin-bootstrap-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('verified dependency fixture');
  const pin = { id: 'fixture', file: 'fixture.jar', bytes: bytes.length, sha256: sha256(bytes), version: 'test' };
  const file = path.join(directory, pin.file);
  await writeFile(file, bytes);
  const valid = await verifyArtifact(file, pin);
  assert.equal(valid.verified, true);
  assert.equal(valid.sha256, sha256(bytes));
  await writeFile(file, Buffer.from('x'.repeat(bytes.length)));
  await assert.rejects(verifyArtifact(file, pin), /hash mismatch/);
  await writeFile(file, 'short');
  await assert.rejects(verifyArtifact(file, pin), /size mismatch/);
  await rm(file);
  await writeFile(path.join(directory, 'target.jar'), bytes);
  await symlink('target.jar', file);
  await assert.rejects(verifyArtifact(file, pin), /Symlink/);
});

test('bootstrap pin separates precompiled tool provenance from the selected source commit', async () => {
  const lock = await loadBootstrapLock();
  assert.equal(lock.version, '2.5.0-dev-10106');
  assert.equal(lock.compilerSourceCommit, null);
  assert.equal(lock.selectedSourceCommit, '4d78aae1e337cd40f69baa865aed950fe807a775');
  const stdlib = lock.artifacts.find((item) => item.id === 'stdlib-wasi');
  assert.equal(stdlib.version, lock.version);
  assert.equal(stdlib.sha256, '7ac1ac3e9081e1e7b00716ddc8dd73723638753536ac13c510baa01530b45942');
});

test('bootstrap pin rejects a mixed target library version before downloading', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kotlin-bootstrap-pin-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'build'));
  for (const file of ['manifest.json', 'sources.lock.json']) await writeFile(path.join(directory, file), await readFile(path.join(ROOT, file)));
  const lock = JSON.parse(await readFile(path.join(ROOT, 'build/bootstrap.lock.json'), 'utf8'));
  lock.artifacts.find((item) => item.id === 'stdlib-wasi').version = '2.4.10';
  await writeFile(path.join(directory, 'build/bootstrap.lock.json'), JSON.stringify(lock));
  await assert.rejects(loadBootstrapLock(directory), /Mixed bootstrap/);
});

function wasm({ start = false, importedModule } = {}) {
  const encode = (value) => [...Buffer.from(value)];
  const type = [1, 4, 1, 96, 0, 0];
  const imported = importedModule ? [2, 9 + importedModule.length, 1, importedModule.length, ...encode(importedModule), 4, ...encode('host'), 0, 0] : [];
  const entryIndex = importedModule ? 1 : 0;
  return Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, ...type, ...imported,
    3, 2, 1, 0, 5, 3, 1, 0, 1,
    7, 19, 2, 6, ...encode('memory'), 2, 0, 6, ...encode('_start'), 0, entryIndex,
    ...(start ? [8, 1, entryIndex] : []), 10, 4, 1, 2, 0, 11]);
}

test('binary evidence identifies command entry, exported memory, and instantiate-time start', () => {
  const plain = inspectWasm(wasm());
  assert.equal(plain.startSection, false);
  assert.equal(plain.memoryExport, 'memory');
  assert.deepEqual(plain.entry, { kind: 'command', exportName: '_start' });
  assert.equal(inspectWasm(wasm({ start: true })).startSection, true);
  assert.throws(() => inspectWasm(wasm({ importedModule: 'env' })), /Unexpected host authority/);
});
