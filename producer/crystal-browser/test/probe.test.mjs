import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyProbe } from '../scripts/probe.mjs';

const failure = (stderr) => ({ exitCode: 1, timedOut: false, stdout: '', stderr });

test('accepts the expected parser diagnostic for the invalid fixture', () => {
	const negative = failure('In /tmp/work/invalid.cr:1:11\n\n 1 | puts (1 + )\n               ^\nError: unexpected token: ")"\n');
	assert.equal(classifyProbe({ baseline: {}, compilerHost: {}, negative }).nativeDiagnostics, true);
});

test('rejects unrelated compiler errors as syntax evidence', () => {
	for (const stderr of [
		'Error: cannot find standard library',
		'In /tmp/work/other.cr:1:1\nError: unexpected token: ")"',
		'In /tmp/work/invalid.cr:1:1\nError: cannot find standard library'
	]) {
		assert.equal(classifyProbe({ baseline: {}, compilerHost: {}, negative: failure(stderr) }).nativeDiagnostics, false);
	}
});
