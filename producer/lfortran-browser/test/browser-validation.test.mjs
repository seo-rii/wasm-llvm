import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VALIDATION_CASES } from '../scripts/shared.mjs';
import { validateBrowserCase } from '../scripts/browser-validate.mjs';

test('browser evidence requires matching output, exit status and both LLVM outputs', () => {
	const expected = VALIDATION_CASES[0];
	const valid = { exitCode: 0, stdout: expected.stdout, stderr: '', generated:
		['program.o', 'program.wasm'].map((name) => ({ name, size: 100, sha256: 'a'.repeat(64) })) };
	assert.doesNotThrow(() => validateBrowserCase(expected, valid));
	for (const change of [{ stdout: '16\n' }, { exitCode: 1 }, { stderr: 'unexpected' },
		{ error: 'worker crashed' }, { generated: valid.generated.slice(0, 1) }]) {
		assert.throws(() => validateBrowserCase(expected, { ...valid, ...change }), /LFortran browser case/u);
	}
});

test('a browser exception is not an upstream invalid-source diagnostic', () => {
	const expected = VALIDATION_CASES.find((fixture) => fixture.exitCode !== 0);
	assert.doesNotThrow(() => validateBrowserCase(expected, {
		exitCode: 1, stdout: '', stderr: 'Error: this_symbol_is_not_declared' }));
	assert.throws(() => validateBrowserCase(expected, { exitCode: 1, stdout: '', stderr: 'RuntimeError: unreachable' }), /symbol diagnostic/u);
	assert.throws(() => validateBrowserCase(expected, null), /LFortran browser case/u);
});
