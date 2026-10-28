import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { CASES, targetGates, validateDiagnostic, validateResult } from './probe-browser-target.mjs';

test('target execution cannot qualify a browser-hosted Swift compiler', () => {
  const results = CASES.map((fixture) => ({ exitCode: 0, stdout: fixture.expected, stderr: '' }));
  assert.deepEqual(targetGates(results), { browserTargetStdinStdout: true, browserHostedCompiler: false, browserHostedSwiftPM: false, ready: false });
});

test('accepts the expected compiler error and rejects success or a broken toolchain', () => {
  const result = { status: 1, stderr: "error: cannot convert value of type 'String' to specified type 'Int'" };
  assert.doesNotThrow(() => validateDiagnostic(result));
  for (const invalid of [null, { ...result, status: 0 }, { ...result, signal: 'SIGTERM' },
    { ...result, error: new Error('spawn failed') }, { status: 1, stderr: 'SDK not found' }]) {
    assert.throws(() => validateDiagnostic(invalid), /Expected Swift/u);
  }
});

test('missing, reordered, failed, truncated and extra output cases cannot pass', () => {
  const results = CASES.map((fixture) => ({ exitCode: 0, stdout: fixture.expected, stderr: '' }));
  assert.equal(targetGates(results.slice(0, 2)).browserTargetStdinStdout, false);
  assert.equal(targetGates([...results].reverse()).browserTargetStdinStdout, false);
  for (const altered of [
    { ...results[0], exitCode: 1 }, { ...results[0], stdout: results[0].stdout.slice(0, -1) },
    { ...results[0], stderr: 'unexpected error' }, { ...results[0], error: 'worker failure' }
  ]) assert.throws(() => validateResult(CASES[0], altered), /fixture failed/u);
  assert.throws(() => validateResult(CASES[0], null), /fixture failed/u);
});

test('observed native evidence is bound to the current full SDK and probe sources', async () => {
  const root = new URL('../', import.meta.url);
  const receipt = JSON.parse(await readFile(new URL('validation/6.4.1-native-target.json', root), 'utf8'));
  const manifestBytes = await readFile(new URL('manifest.json', root));
  const manifest = JSON.parse(manifestBytes);
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(receipt.manifestSha256, digest(manifestBytes));
  for (const [name, expected] of Object.entries(receipt.sourceFiles)) {
    assert.equal(digest(await readFile(new URL(name, root))), expected, name);
  }
  assert.equal(receipt.sdk, manifest.wasmSdk.id);
  assert.equal(receipt.archives[1].url, manifest.wasmSdk.url);
  assert.equal(receipt.archives[1].sha256, manifest.wasmSdk.sha256);
  assert.equal(receipt.compilerHost, 'native');
  assert.ok(receipt.diagnostic.exitCode > 0);
  assert.deepEqual(receipt.gates, targetGates(receipt.browser.results));
});
