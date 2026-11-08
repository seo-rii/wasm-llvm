import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtures, verifyRuntimeResult } from './runtime-fixtures.mjs';

// Assertion-unit tests only. Actual compiler/engine evidence is produced and
// reopened by runtime-probe.mjs; these observations are not runtime receipts.
const successful = fixture => ({ stdout: fixture.stdout, stderr: '', outputLimitExceeded: false, status: 'completed', exitCode: 0 });
test('entry observation guards reject false successes and changed results', async t => {
  for (const fixture of fixtures.filter(row => !row.compileError)) {
    const result = fixture.runtimeError ? { ...successful(fixture), status: 'runtime-error', exitCode: null,
      error: fixture.runtimeError === 'missing-entry' ? 'Kotlin WASI command must export _start'
        : fixture.runtimeError === 'duplicate-export' ? 'Duplicate export name' : 'wasm exception' } : successful(fixture);
    await t.test(fixture.id + ' expected result', () => verifyRuntimeResult(fixture, result));
    await t.test(fixture.id + ' output drift', () => assert.throws(() => verifyRuntimeResult(fixture, { ...result, stdout: result.stdout + 'wrong' })));
    await t.test(fixture.id + ' truncated output', () => assert.throws(() => verifyRuntimeResult(fixture, { ...result, outputLimitExceeded: true })));
    if (fixture.runtimeError) await t.test(fixture.id + ' failure cannot become success', () =>
      assert.throws(() => verifyRuntimeResult(fixture, successful(fixture))));
  }
});
