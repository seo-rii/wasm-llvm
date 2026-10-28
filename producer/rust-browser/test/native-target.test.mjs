import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { CASES, assertCompilerVersion, targetGates, validateResult } from '../scripts/probe-native-target.mjs';

test('native target execution cannot qualify a browser-hosted Rust compiler', () => {
  const results = CASES.map((fixture) => ({ exitCode: 0, stdout: fixture.expected, stderr: '' }));
  assert.deepEqual(targetGates(results, results), { nodeWasiStdinStdout: true, browserTargetStdinStdout: true, browserHostedCompiler: false, ready: false });
  assert.equal(targetGates(results.slice(0, 2), results).nodeWasiStdinStdout, false);
  assert.equal(targetGates(results, [...results].reverse()).browserTargetStdinStdout, false);
  for (const altered of [{ ...results[0], stdout: results[0].stdout.trimEnd() }, { ...results[0], exitCode: 1 },
    { ...results[0], stderr: 'unexpected' }, { ...results[0], error: 'worker failed' }]) {
    assert.throws(() => validateResult(CASES[0], altered), /fixture failed/u);
  }
});

test('rejects another release, source commit or compiler host', () => {
  const source = { version: '1.99.1', commit: 'a'.repeat(40) };
  const version = 'rustc\nrelease: 1.99.1\ncommit-hash: ' + source.commit + '\nhost: x86_64-unknown-linux-gnu\n';
  assert.doesNotThrow(() => assertCompilerVersion(version, source));
  for (const invalid of [version.replace('1.99.1', '1.99.0'), version.replace(source.commit, 'b'.repeat(40)), version.replace('x86_64-unknown-linux-gnu', 'wasm32-wasip1-threads')]) {
    assert.throws(() => assertCompilerVersion(invalid, source), /does not match/u);
  }
});

test('observed native evidence is bound to the current probe inputs and keeps browser compiler gates closed', async () => {
  const root = new URL('../', import.meta.url);
  const receipt = JSON.parse(await readFile(new URL('validation/1.99.1-native-target.json', root), 'utf8'));
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(receipt.manifestSha256, digest(await readFile(new URL('manifest.json', root))));
  for (const [name, expected] of Object.entries(receipt.sourceFiles)) {
    assert.equal(digest(await readFile(new URL(name, root))), expected, name);
  }
  assert.equal(receipt.compilerHost, 'native');
  assert.equal(receipt.diagnostic.exitCode, 1);
  assert.equal(receipt.diagnostic.code, 'E0308');
  assert.deepEqual(receipt.gates, targetGates(receipt.node.results, receipt.browser.results));
});
