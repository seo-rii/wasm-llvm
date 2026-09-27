import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../producer/clang-browser/scripts/build-toolchain.mjs', import.meta.url));

function help(env = {}) {
	return spawnSync(process.execPath, [script, '--help'], {
		cwd: path.dirname(script),
		env: { ...process.env, CLANGD_LTO: '', ...env },
		encoding: 'utf8'
	});
}

test('build help reports LTO enabled by default and accepts a baseline comparison', () => {
	const defaults = help();
	assert.equal(defaults.status, 0, defaults.stderr);
	assert.match(defaults.stdout, /CLANGD_LTO=ON/);
	const baseline = help({ CLANGD_LTO: 'OFF' });
	assert.equal(baseline.status, 0, baseline.stderr);
	assert.match(baseline.stdout, /CLANGD_LTO=OFF/);
});

test('rejects a misspelled LTO mode before starting the producer', () => {
	const result = help({ CLANGD_LTO: 'OF' });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /CLANGD_LTO must be ON or OFF/);
	assert.equal(result.stdout, '');
});
