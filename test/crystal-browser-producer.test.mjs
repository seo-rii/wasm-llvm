import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertWasmObject, classifyProbe, manifest, run, verifyBootstrap, verifySource } from '../producer/crystal-browser/scripts/probe.mjs';

async function git(directory, args) {
  const result = await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '-c', 'user.name=Crystal producer test', '-c', 'user.email=crystal-test@example.invalid', ...args], { cwd: directory });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function sourceFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'crystal-source-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await git(directory, ['init']);
  await writeFile(path.join(directory, 'main.cr'), 'VALUE = 1\n');
  await writeFile(path.join(directory, 'helper.cr'), 'OTHER = 1\n');
  await writeFile(path.join(directory, '.gitignore'), 'ignored.cr\n');
  await symlink('main.cr', path.join(directory, 'source-link'));
  await git(directory, ['add', '.']);
  await git(directory, ['commit', '-m', 'fixture']);
  return { directory, expected: { commit: await git(directory, ['rev-parse', 'HEAD']) } };
}

test('pinned source accepts intact tracked files and symlinks but rejects the wrong revision', async (t) => {
  const { directory, expected } = await sourceFixture(t);
  assert.equal(await verifySource(directory, expected), expected.commit);
  await assert.rejects(verifySource(directory, { commit: '0'.repeat(40) }), /revision does not match/u);
});

test('pinned source rejects untracked and ignored input injection', async (t) => {
  const { directory, expected } = await sourceFixture(t);
  for (const filename of ['injected.cr', 'ignored.cr']) {
    await writeFile(path.join(directory, filename), 'INJECTED = true\n');
    await assert.rejects(verifySource(directory, expected), /including ignored and untracked/u);
    await rm(path.join(directory, filename));
  }
  assert.equal(await verifySource(directory, expected), expected.commit);
});

test('Git blob verification detects tracked changes hidden by either index flag', async (t) => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const { directory, expected } = await sourceFixture(t);
    await git(directory, ['update-index', flag, 'helper.cr']);
    await writeFile(path.join(directory, 'helper.cr'), 'OTHER = 2\n');
    assert.equal(await git(directory, ['status', '--porcelain']), '');
    await assert.rejects(verifySource(directory, expected), /Source Git blob mismatch: helper\.cr/u);
  }
});

test('Git blob verification checks symlink text without following its target', async (t) => {
  const { directory, expected } = await sourceFixture(t);
  await git(directory, ['update-index', '--assume-unchanged', 'source-link']);
  await rm(path.join(directory, 'source-link'));
  await symlink('helper.cr', path.join(directory, 'source-link'));
  assert.equal(await git(directory, ['status', '--porcelain']), '');
  await assert.rejects(verifySource(directory, expected), /Source Git blob mismatch: source-link/u);
});

test('native object compilation cannot qualify browser execution', () => {
  const success = { exitCode: 0, wasmObject: true, stdout: '', stderr: '' };
  const gates = classifyProbe({ baseline: success, compilerHost: success,
    negative: { exitCode: 1, timedOut: false, stdout: '', stderr: 'Syntax error in invalid.cr' } });
  assert.equal(gates.nativeWasiObject, true);
  assert.equal(gates.compilerHostObject, true);
  assert.equal(gates.nativeDiagnostics, true);
  assert.equal(gates.browserCompiler, false);
  assert.equal(gates.browserStdinStdout, false);
  assert.equal(gates.ready, false);
  assert.equal(manifest.readiness.ready, false);
});

test('a timeout or signal is not accepted as a syntax diagnostic', () => {
  for (const failure of [{ exitCode: null, timedOut: false }, { exitCode: 1, timedOut: true }]) {
    const gates = classifyProbe({ baseline: {}, compilerHost: {}, negative: { ...failure, stdout: '', stderr: 'Error: timeout' } });
    assert.equal(gates.nativeDiagnostics, false);
  }
});

test('native ELF and malformed objects are rejected', () => {
  assert.throws(() => assertWasmObject(Buffer.from([0x7f, 69, 76, 70, 0, 0, 0, 0])), /WebAssembly object/u);
  assert.throws(() => assertWasmObject(Buffer.from([0, 97, 115, 109])), /WebAssembly object/u);
  assert.throws(() => assertWasmObject(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])), /relocatable object/u);
  const linking = Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0, 9, 7]), Buffer.from('linking'), Buffer.from([2])]);
  assert.doesNotThrow(() => assertWasmObject(linking));
  linking[linking.length - 1] = 1;
  assert.throws(() => assertWasmObject(linking), /version 2/u);
});

test('an unverified bootstrap is rejected before execution', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crystal-bootstrap-test-'));
  try {
    const file = path.join(directory, 'archive.tar.gz');
    await writeFile(file, 'unexpected bytes');
    await assert.rejects(verifyBootstrap(file), /pinned size and SHA-256/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the probe bounds compiler lifetime and reports termination', async () => {
  const result = await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 40 });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, 'SIGTERM');
});
