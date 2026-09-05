import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertWasmObject, classifyProbe, manifest, run, verifyBootstrap } from '../producer/crystal-browser/scripts/probe.mjs';

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
