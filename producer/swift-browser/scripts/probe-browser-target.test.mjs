import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CASES, targetGates, validateResult } from './probe-browser-target.mjs';

test('target execution cannot qualify a browser-hosted Swift compiler', () => {
  const results = CASES.map((fixture) => ({ exitCode: 0, stdout: fixture.expected, stderr: '' }));
  assert.deepEqual(targetGates(results), { browserTargetStdinStdout: true, browserHostedCompiler: false, browserHostedSwiftPM: false, ready: false });
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
