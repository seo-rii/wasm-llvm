import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
			LLVM_HOT_PATH_OPT: '',
			LLVM_HOT_PATH_DIRS: '',
			CLANG_WASM_OPT: '',
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

test('optimizes the WASI compiler modules with the pinned Binaryen instead of the host PATH', () => {
	const source = readFileSync(script, 'utf8');
	const linkerFlags = source.match(/const wasiLinkerFlags =\s*'([^']*)'/)?.[1] ?? '';
	assert.match(linkerFlags, /(^| )--no-wasm-opt( |$)/);
	assert.match(linkerFlags, /-Wl,--keep-section=target_features/);
	assert.match(source, /path\.join\(emsdkDir, 'upstream', 'bin', 'wasm-opt'\)/);
	assert.match(source, /MinSizeRel: config\.llvmMinSizeOpt/);
	assert.match(source, /config\.clangWasmOpt === 'default' \? wasmOptLevel : config\.clangWasmOpt/);
	assert.match(source, /'--clang-wasm',\s*clangWasm,\s*'--lld-wasm',\s*lldWasm/);
});

test('keeps speed profiles off by default and accepts hot-path and wasm-opt comparisons', () => {
	const defaults = help();
	assert.equal(defaults.status, 0, defaults.stderr);
	assert.match(defaults.stdout, /LLVM_HOT_PATH_OPT=none/);
	assert.match(defaults.stdout, /LLVM_HOT_PATH_DIRS=clang\/lib\/Lex,clang\/lib\/Basic,llvm\/lib\/Support\n/);
	assert.match(defaults.stdout, /CLANG_WASM_OPT=default/);
	const speed = help({
		LLVM_HOT_PATH_OPT: 'O2',
		LLVM_HOT_PATH_DIRS: 'clang/lib/Lex, llvm/lib/Support',
		CLANG_WASM_OPT: 'O3'
	});
	assert.equal(speed.status, 0, speed.stderr);
	assert.match(speed.stdout, /LLVM_HOT_PATH_OPT=O2/);
	assert.match(speed.stdout, /LLVM_HOT_PATH_DIRS=clang\/lib\/Lex,llvm\/lib\/Support\n/);
	assert.match(speed.stdout, /CLANG_WASM_OPT=O3/);
	assert.match(speed.stdout, /--compiler-only/);
});

test('rejects invalid speed profile settings before any build starts', () => {
	for (const [env, message] of [
		[{ LLVM_HOT_PATH_OPT: 'O1' }, /LLVM_HOT_PATH_OPT must be none, O2 or O3/],
		[
			{ LLVM_HOT_PATH_OPT: 'O2', LLVM_BUILD_TYPE: 'Release' },
			/LLVM_HOT_PATH_OPT requires LLVM_BUILD_TYPE=MinSizeRel/
		],
		[{ LLVM_HOT_PATH_DIRS: '../clang/lib/Sema' }, /LLVM_HOT_PATH_DIRS entries must be relative/],
		[{ LLVM_HOT_PATH_DIRS: '/abs/clang' }, /LLVM_HOT_PATH_DIRS entries must be relative/],
		[{ CLANG_WASM_OPT: 'O4' }, /CLANG_WASM_OPT must be default, O2 or O3/]
	]) {
		const result = help(env);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, message);
		assert.equal(result.stdout, '');
	}
});

test('hot-path launcher raises only matching sources to the requested level', () => {
	const launcher = fileURLToPath(
		new URL('../producer/clang-browser/scripts/hot-path-launcher.sh', import.meta.url)
	);
	const hotDirs = '/src/clang/lib/Sema:/src/llvm/lib/Support';
	const compile = (level, source) => {
		const result = spawnSync(launcher, ['O2', hotDirs, 'echo', level, '-c', source], {
			encoding: 'utf8'
		});
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim().split(' ')[0];
	};
	assert.equal(compile('-Oz', '/src/clang/lib/Sema/Sema.cpp'), '-O2');
	assert.equal(compile('-Os', '/src/llvm/lib/Support/APInt.cpp'), '-O2');
	assert.equal(compile('-Oz', '/src/clang/lib/CodeGen/CGCall.cpp'), '-Oz');
	assert.equal(compile('-Oz', '/src/clang/lib/SemaX/a.cpp'), '-Oz');
});
