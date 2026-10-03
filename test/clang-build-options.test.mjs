import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../producer/clang-browser/scripts/build-toolchain.mjs', import.meta.url));

function help(env = {}) {
	return spawnSync(process.execPath, [script, '--help'], {
		cwd: path.dirname(script),
		env: {
			...process.env,
			CLANGD_LTO: '',
			LLVM_MINSIZE_OPT: '',
			LLVM_BUILD_TYPE: '',
			CLANGD_ASSERTIONS: '',
			CLANGD_TIDY_CHECKS: '',
			CLANGD_DECISION_FOREST: '',
			...env
		},
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

test('reports size-first optimization and accepts the previous MinSizeRel level', () => {
	const defaults = help();
	assert.equal(defaults.status, 0, defaults.stderr);
	assert.match(defaults.stdout, /LLVM_MINSIZE_OPT=Oz/);
	const baseline = help({ LLVM_MINSIZE_OPT: 'Os' });
	assert.equal(baseline.status, 0, baseline.stderr);
	assert.match(baseline.stdout, /LLVM_MINSIZE_OPT=Os/);
});

test('rejects optimization values that are not supported size comparison modes', () => {
	const result = help({ LLVM_MINSIZE_OPT: 'O3' });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /LLVM_MINSIZE_OPT must be Os or Oz/);
	assert.equal(result.stdout, '');
});

test('runtime assertions follow release/debug defaults and allow explicit overrides', () => {
	for (const [env, expected] of [
		[{}, 'OFF'],
		[{ LLVM_BUILD_TYPE: 'Debug' }, 'ON'],
		[{ LLVM_BUILD_TYPE: 'Release' }, 'OFF'],
		[{ CLANGD_ASSERTIONS: 'ON' }, 'ON'],
		[{ LLVM_BUILD_TYPE: 'Debug', CLANGD_ASSERTIONS: 'OFF' }, 'OFF']
	]) {
		const result = help(env);
		assert.equal(result.status, 0, result.stderr);
		assert.ok(result.stdout.includes(`CLANGD_ASSERTIONS=${expected}`));
	}
});

test('rejects invalid runtime assertion settings before any build starts', () => {
	const result = help({ CLANGD_ASSERTIONS: 'false' });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /CLANGD_ASSERTIONS must be ON or OFF/);
	assert.equal(result.stdout, '');
});

test('omits tidy checks by default and accepts a full-feature comparison', () => {
	const defaults = help();
	assert.equal(defaults.status, 0, defaults.stderr);
	assert.match(defaults.stdout, /CLANGD_TIDY_CHECKS=OFF/);
	const full = help({ CLANGD_TIDY_CHECKS: 'ON' });
	assert.equal(full.status, 0, full.stderr);
	assert.match(full.stdout, /CLANGD_TIDY_CHECKS=ON/);
});

test('rejects invalid tidy feature settings before any build starts', () => {
	const result = help({ CLANGD_TIDY_CHECKS: 'ALL' });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /CLANGD_TIDY_CHECKS must be ON or OFF/);
	assert.equal(result.stdout, '');
});

test('uses heuristic completion by default and accepts restoring the ranking model', () => {
	const defaults = help();
	assert.equal(defaults.status, 0, defaults.stderr);
	assert.match(defaults.stdout, /CLANGD_DECISION_FOREST=OFF/);
	const full = help({ CLANGD_DECISION_FOREST: 'ON' });
	assert.equal(full.status, 0, full.stderr);
	assert.match(full.stdout, /CLANGD_DECISION_FOREST=ON/);
});

test('rejects invalid completion model settings before any build starts', () => {
	const result = help({ CLANGD_DECISION_FOREST: 'heuristics' });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /CLANGD_DECISION_FOREST must be ON or OFF/);
	assert.equal(result.stdout, '');
});
