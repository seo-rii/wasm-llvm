import assert from 'node:assert/strict';
import test from 'node:test';

import {
	MODULE_COMPAT_DEFINES,
	MODULE_FLAGS,
	compileArgs,
	parseArgs
} from '../producer/clang-browser/scripts/probe-header-modules.mjs';

test('requires the compiler, shipped sysroot and WASI SDK sysroot', () => {
	const options = parseArgs([
		'--compiler',
		'artifacts/clang-browser',
		'--sysroot',
		'artifacts/clang-browser/sysroot.tar.zip',
		'--wasi-sysroot',
		'wasi-sysroot-33.0+m.tar.gz',
		'--runs',
		'4'
	]);
	assert.equal(options.runs, 4);
	assert.throws(() => parseArgs(['--compiler', 'x', '--sysroot', 'y']), /--wasi-sysroot/);
	assert.throws(
		() =>
			parseArgs(['--compiler', 'x', '--sysroot', 'y', '--wasi-sysroot', 'z', '--runs', '1']),
		/at least 2/
	);
	assert.throws(() => parseArgs(['--unknown']), /Unknown argument/);
});

test('appends module flags after the browser host cc1 arguments', () => {
	const args = compileArgs('/work/main.cpp', '/work/main.o', MODULE_FLAGS);
	assert.deepEqual(args.slice(0, 3), ['clang', '-cc1', '-triple']);
	assert.deepEqual(args.slice(-3), ['-o', '/work/main.o', '/work/main.cpp']);
	for (const flag of ['-fmodules', '-fimplicit-module-maps', ...MODULE_COMPAT_DEFINES]) {
		assert.ok(args.includes(flag), flag);
	}
	assert.ok(args.indexOf('-x') < args.indexOf('-fmodules'));
});
