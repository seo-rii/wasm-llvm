import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
	createVerifyWasiFrontendCommands,
	parseVerifyWasiFrontendArgs,
	verifyWasiFrontend
} from './verify-wasi-frontend.mjs';

test('parses Swift WASI frontend verification arguments and defaults', () => {
	const sourceRoot = path.resolve('source');
	assert.deepEqual(parseVerifyWasiFrontendArgs(['--source-root', 'source']), {
		sourceRoot,
		buildDir: path.join(sourceRoot, 'browser-compiler-wasi'),
		nativeBuildDir: path.join(sourceRoot, 'build', 'buildbot_linux'),
		frontendPath: path.join(sourceRoot, 'browser-compiler-wasi', 'swift-wasi', 'bin', 'swift-frontend'),
		workDir: path.join(sourceRoot, 'browser-compiler-wasi', 'wasi-frontend-verification'),
		receiptPath: path.join(
			sourceRoot,
			'browser-compiler-wasi',
			'wasm-idle-swift-wasi-frontend-verification.json'
		)
	});
	assert.deepEqual(
		parseVerifyWasiFrontendArgs([
			'--source-root', 'source',
			'--build-dir', 'build',
			'--native-build-dir', 'native',
			'--frontend', 'frontend.wasm',
			'--work-dir', 'work',
			'--receipt', 'receipt.json'
		]),
		{
			sourceRoot,
			buildDir: path.resolve('build'),
			nativeBuildDir: path.resolve('native'),
			frontendPath: path.resolve('frontend.wasm'),
			workDir: path.resolve('work'),
			receiptPath: path.resolve('receipt.json')
		}
	);
	assert.deepEqual(parseVerifyWasiFrontendArgs(['--help']), { help: true });
	assert.throws(() => parseVerifyWasiFrontendArgs([]), /--source-root is required/u);
	assert.throws(
		() => parseVerifyWasiFrontendArgs(['--source-root', 'source', '--frontend']),
		/--frontend requires a value/u
	);
	assert.throws(
		() => parseVerifyWasiFrontendArgs(['--source-root', 'source', '--unknown']),
		/Unknown option: --unknown/u
	);
});

test('constructs the WasmKit compile, autolink, and native link commands', () => {
	const options = parseVerifyWasiFrontendArgs([
		'--source-root', '/source',
		'--build-dir', '/build',
		'--native-build-dir', '/native',
		'--frontend', '/frontend/bin/swift-frontend',
		'--work-dir', '/work'
	]);
	const plan = createVerifyWasiFrontendCommands(options);

	assert.equal(
		plan.paths.wasmKit,
		'/native/wasmkit-linux-x86_64/x86_64-unknown-linux-gnu/release/wasmkit-cli'
	);
	assert.equal(
		plan.paths.wasmKitLibraryDir,
		'/native/none-swift_package_sandbox_linux-x86_64/usr/lib/swift/linux'
	);
	assert.equal(plan.paths.autolinkExtract, '/frontend/bin/swift-autolink-extract');
	assert.equal(plan.paths.clang, '/native/llvm-linux-x86_64/bin/clang');
	assert.equal(plan.paths.wasiSysroot, '/native/wasi-sysroot/wasm32-wasip1/sysroot');
	assert.equal(
		plan.paths.swiftRuntimeObject,
		'/native/wasmstdlib-linux-x86_64/lib/swift_static/wasi/wasm32/swiftrt.o'
	);
	assert.equal(
		plan.paths.builtins,
		'/native/wasi-sysroot/wasm32-wasip1/resource-dir/lib/wasip1/libclang_rt.builtins-wasm32.a'
	);
	assert.deepEqual(plan.commands.compileSwift.slice(0, 6), [
		plan.paths.wasmKit, 'run', '--stack-size', '67108864', '--dir', '/source'
	]);
	assert.ok(plan.commands.compileSwift.includes('/frontend/bin/swift-frontend'));
	assert.ok(plan.commands.compileSwift.includes('-use-static-resource-dir'));
	assert.ok(plan.commands.compileSwift.includes('-module-cache-path'));
	assert.ok(plan.commands.extractAutolink.includes('/frontend/bin/swift-autolink-extract'));
	assert.ok(plan.commands.link.includes(plan.paths.swiftRuntimeObject));
	assert.ok(plan.commands.link.includes(`@${plan.paths.autolinkFile}`));
	assert.ok(plan.commands.link.includes(`@${plan.paths.staticExecutableArgs}`));
	assert.ok(plan.commands.link.includes(plan.paths.wasiResourceDir));
	assert.equal(plan.commands.link.includes(plan.paths.builtins), false);
	assert.deepEqual(plan.commands.runWasm, [plan.paths.wasmKit, 'run', plan.paths.wasmOutput]);
});

test('verifies the WASI frontend end to end through injected process and filesystem checks', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-verify-wasi-frontend-'));
	try {
		const options = parseVerifyWasiFrontendArgs([
			'--source-root', path.join(dir, 'source'),
			'--build-dir', path.join(dir, 'build'),
			'--native-build-dir', path.join(dir, 'native'),
			'--work-dir', path.join(dir, 'work'),
			'--receipt', path.join(dir, 'receipt.json')
		]);
		const calls = [];
		const accessed = [];
		const inspected = [];
		const receipt = await verifyWasiFrontend(options, {
			access: async (filePath) => { accessed.push(filePath); },
			stat: async (filePath) => {
				inspected.push(filePath);
				return { size: 64, isFile: () => true };
			},
			run: async (command, args, runOptions) => {
				calls.push({ command, args, options: runOptions });
				return {
					exitCode: 0,
					signal: null,
					stdout: calls.length === 4 ? 'swift-stdin:swift-stdin-ok\n' : '',
					stderr: calls.length === 1 ? 'warning: path_rename is unsupported\n' : ''
				};
			}
		});

		const plan = createVerifyWasiFrontendCommands(options);
		assert.equal(receipt.status, 'passed');
		assert.equal(receipt.actualStdout, 'swift-stdin:swift-stdin-ok\n');
		assert.equal(receipt.errorMessage, null);
		assert.equal(calls.length, 4);
		assert.equal(calls[0].command, plan.paths.wasmKit);
		assert.equal(calls[1].args.includes(plan.paths.autolinkExtract), true);
		assert.equal(calls[2].command, plan.paths.clang);
		assert.equal(calls[3].options.input, 'swift-stdin-ok\n');
		assert.equal(calls[0].options.env.LD_LIBRARY_PATH, plan.paths.wasmKitLibraryDir);
		assert.equal(calls[1].options.env.LD_LIBRARY_PATH, plan.paths.wasmKitLibraryDir);
		assert.equal(calls[3].options.env.LD_LIBRARY_PATH, plan.paths.wasmKitLibraryDir);
		assert.deepEqual(inspected, [
			plan.paths.swiftObject,
			plan.paths.autolinkFile,
			plan.paths.wasmOutput
		]);
		assert.ok(accessed.includes(plan.paths.frontend));
		assert.ok(accessed.includes(plan.paths.builtins));
		assert.deepEqual(JSON.parse(await readFile(options.receiptPath, 'utf8')), receipt);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects an exit-zero WasmKit compile that did not create its output and writes a receipt', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-verify-wasi-missing-'));
	try {
		const options = parseVerifyWasiFrontendArgs([
			'--source-root', path.join(dir, 'source'),
			'--build-dir', path.join(dir, 'build'),
			'--work-dir', path.join(dir, 'work'),
			'--receipt', path.join(dir, 'receipt.json')
		]);
		await assert.rejects(
			() => verifyWasiFrontend(options, {
				access: async () => {},
				stat: async () => { throw new Error('ENOENT'); },
				run: async () => ({
					exitCode: 0,
					signal: null,
					stdout: '',
					stderr: 'warning: path_rename is unsupported\n'
				})
			}),
			/swift-frontend exited successfully but did not produce/u
		);
		const receipt = JSON.parse(await readFile(options.receiptPath, 'utf8'));
		assert.equal(receipt.status, 'failed');
		assert.match(receipt.errorMessage, /did not produce/u);
		assert.deepEqual(receipt.outputs, {});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('requires byte-identical stdout and records execution failures', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-verify-wasi-stdout-'));
	try {
		const options = parseVerifyWasiFrontendArgs([
			'--source-root', path.join(dir, 'source'),
			'--work-dir', path.join(dir, 'work'),
			'--receipt', path.join(dir, 'receipt.json')
		]);
		let callCount = 0;
		await assert.rejects(
			() => verifyWasiFrontend(options, {
				access: async () => {},
				stat: async () => ({ size: 8, isFile: () => true }),
				run: async () => {
					callCount += 1;
					return {
						exitCode: 0,
						signal: null,
						stdout: callCount === 4 ? 'swift-stdin:swift-stdin-ok\nextra\n' : '',
						stderr: ''
					};
				}
			}),
			/unexpected stdout/u
		);
		const receipt = JSON.parse(await readFile(options.receiptPath, 'utf8'));
		assert.equal(receipt.status, 'failed');
		assert.equal(receipt.expectedStdout, 'swift-stdin:swift-stdin-ok\n');
		assert.equal(receipt.actualStdout, 'swift-stdin:swift-stdin-ok\nextra\n');
		assert.match(receipt.errorMessage, /unexpected stdout/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
