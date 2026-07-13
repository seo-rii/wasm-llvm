import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
	buildWasiCompilerPrerequisites,
	createLlvmWasiConfigureCommand,
	createWasiToolchainSource,
	inspectWasmOutput,
	parseBuildWasiCompilerArgs
} from './build-wasi-compiler.mjs';

test('parses Swift WASI compiler build arguments', () => {
	const sourceRoot = path.resolve('swift-source');
	assert.deepEqual(
		parseBuildWasiCompilerArgs([
			'--source-root', 'swift-source',
			'--llvm-source-root', 'llvm-source',
			'--build-dir', 'browser-build',
			'--native-build-dir', 'native-build',
			'--jobs', '3',
			'--receipt', 'receipt.json',
			'--execute',
			'--configure-only',
			'--skip-patch'
		]),
		{
			sourceRoot,
			llvmSourceRoot: path.resolve('llvm-source'),
			buildDir: path.resolve('browser-build'),
			nativeBuildDir: path.resolve('native-build'),
			jobs: 3,
			execute: true,
			configureOnly: true,
			skipPatch: true,
			receiptPath: path.resolve('receipt.json')
		}
	);
	assert.deepEqual(parseBuildWasiCompilerArgs(['--help']), { help: true });
	assert.throws(() => parseBuildWasiCompilerArgs([]), /--source-root is required/u);
	assert.throws(() => parseBuildWasiCompilerArgs(['--source-root', 'src', '--jobs', '0']), /positive integer/u);
	assert.throws(() => parseBuildWasiCompilerArgs(['--source-root', 'src', '--bad']), /Unknown option/u);
});

test('generates a wasm32-wasip1 CMake toolchain and LLVM command', () => {
	const source = createWasiToolchainSource({ nativeLlvmDir: '/native/llvm', wasiSysroot: '/native/wasi' });
	assert.match(source, /set\(CMAKE_SYSTEM_NAME WASI\)/u);
	assert.match(source, /set\(CMAKE_CXX_COMPILER_TARGET "wasm32-wasip1"\)/u);
	assert.match(source, /llvm-wasi-thread-shim\.h/u);
	assert.match(source, /-D_WASI_EMULATED_MMAN/u);
	assert.match(source, /-lwasi-emulated-mman/u);
	assert.match(source, /--max-memory=2147483648/u);
	const command = createLlvmWasiConfigureCommand({
		llvmSourceRoot: '/llvm-source',
		llvmBuildDir: '/build/llvm-wasi',
		toolchainPath: '/build/toolchain.cmake',
		nativeLlvmDir: '/native/llvm'
	});
	assert.equal(command[0], '/usr/bin/cmake');
	assert.ok(command.includes('/llvm-source/llvm'));
	assert.ok(command.includes('-DLLVM_HOST_TRIPLE=wasm32-unknown-wasip1'));
	assert.ok(command.includes('-DCMAKE_BUILD_TYPE=MinSizeRel'));
	assert.ok(command.includes('-DLLVM_ENABLE_PROJECTS=clang;lld'));
	assert.ok(command.includes('-DCLANG_ENABLE_OBJC_REWRITER=OFF'));
	assert.ok(command.includes('-UHAVE_SYS_MMAN_H'));
	assert.ok(command.some((argument) => argument.startsWith('-DCMAKE_C_FLAGS=-D_WASI_EMULATED_GETPID')));
	assert.ok(command.some((argument) => argument.includes('-lwasi-emulated-mman')));
});

test('provides synchronous no-thread WASI thread and future primitives', async () => {
	const shim = await readFile(new URL('../patches/llvm-wasi-thread-shim.h', import.meta.url), 'utf8');
	assert.match(shim, /class thread/u);
	assert.match(shim, /template <class Value> class promise/u);
	assert.match(shim, /template <class Value> class future/u);
	assert.match(shim, /template <class Value> class shared_future/u);
	assert.match(shim, /#pragma clang module import std/u);
	assert.match(shim, /auto async\(launch/u);
});

test('keeps unavailable process, lock, and JIT frame services out of the WASI host', async () => {
	const patch = await readFile(new URL('../patches/llvm-wasi-platform.patch', import.meta.url), 'utf8');
	assert.match(patch, /#if LLVM_ON_UNIX && !defined\(__wasi__\)[\s\S]*cc1depscand_main/u);
	assert.match(patch, /std::error_code cas::ondisk::lockFileThreadSafe[\s\S]*#if defined\(__wasi__\)[\s\S]*return std::error_code\(\);/u);
	assert.match(patch, /cas::ondisk::tryLockFileThreadSafe[\s\S]*#if defined\(__wasi__\)[\s\S]*return std::error_code\(\);/u);
	assert.match(patch, /ExecutionEngine\/Orc\/TargetProcess\/RegisterEHFrames\.cpp[\s\S]*!defined\(__wasi__\)/u);
	assert.match(patch, /ExecutionEngine\/RuntimeDyld\/RTDyldMemoryManager\.cpp[\s\S]*!defined\(__wasi__\)/u);
});

test('validates complete produced WASI compiler modules', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-wasm-output-'));
	try {
		const output = path.join(dir, 'clang');
		await writeFile(output, Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
		assert.deepEqual(await inspectWasmOutput(output), { path: output, bytes: 8 });
		await writeFile(output, Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1));
		await assert.rejects(() => inspectWasmOutput(output), /not a valid WebAssembly module/u);
		await writeFile(output, 'native');
		await assert.rejects(() => inspectWasmOutput(output), /not a WebAssembly 1\.0 module/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('writes a dry-run Swift WASI compiler receipt without executing commands', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-wasi-dry-'));
	try {
		const options = parseBuildWasiCompilerArgs([
			'--source-root', path.join(dir, 'source'),
			'--build-dir', path.join(dir, 'build')
		]);
		const receipt = await buildWasiCompilerPrerequisites(options, {
			run: async () => {
				throw new Error('should not run');
			}
		});
		assert.equal(receipt.status, 'dry-run');
		assert.equal(receipt.patchStatus, 'pending');
		assert.equal(receipt.errorMessage, null);
		assert.deepEqual(JSON.parse(await readFile(options.receiptPath, 'utf8')), receipt);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('configures and builds Swift WASI compiler prerequisites with recorded commands', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-wasi-run-'));
	try {
		const sourceRoot = path.join(dir, 'source');
		const nativeBuildDir = path.join(sourceRoot, 'build', 'buildbot_linux');
		const builtins = path.join(
			nativeBuildDir,
			'wasmllvmruntimelibs-linux-x86_64/wasm32-wasip1/compiler-rt/lib/wasip1/libclang_rt.builtins-wasm32.a'
		);
		await mkdir(path.dirname(builtins), { recursive: true });
		await mkdir(path.join(sourceRoot, 'llvm-project'), { recursive: true });
		await writeFile(builtins, 'builtins');
		const options = parseBuildWasiCompilerArgs([
			'--source-root', sourceRoot,
			'--native-build-dir', nativeBuildDir,
			'--build-dir', path.join(dir, 'browser'),
			'--jobs', '2',
			'--execute'
		]);
		const calls = [];
		const swiftLinkTargets = [
			'LLVMMCJIT', 'LLVMOrcJIT', 'LLVMExecutionEngine', 'LLVMRuntimeDyld',
			'LLVMJITLink', 'LLVMOrcTargetProcess', 'LLVMOrcShared', 'clangTooling',
			'clangToolingRefactor', 'clangToolingRefactoring', 'clangToolingSyntax'
		];
		const receipt = await buildWasiCompilerPrerequisites(options, {
			run: async (command, args, runOptions = {}) => {
				calls.push({ command, args, options: runOptions });
				if (command === '/usr/bin/ninja') {
					const outputDir = path.join(options.buildDir, 'llvm-wasi', 'bin');
					const libraryDir = path.join(options.buildDir, 'llvm-wasi', 'lib');
					await mkdir(outputDir, { recursive: true });
					await mkdir(libraryDir, { recursive: true });
					const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
					await Promise.all([
						writeFile(path.join(outputDir, 'clang'), wasm),
						writeFile(path.join(outputDir, 'lld'), wasm),
						...swiftLinkTargets.map((target) => writeFile(path.join(libraryDir, `lib${target}.a`), 'archive'))
					]);
				}
				return { exitCode: 0, signal: null, stdout: '', stderr: '' };
			}
		});
		assert.equal(receipt.status, 'passed');
		assert.equal(receipt.buildType, 'MinSizeRel');
		assert.deepEqual(receipt.outputs?.map((output) => output.bytes), [8, 8]);
		assert.equal(receipt.patchStatus, 'already-applied');
		assert.equal(calls[0].command, 'git');
		assert.deepEqual(calls[0].args.slice(0, 3), ['apply', '--reverse', '--check']);
		assert.equal(calls.at(-1).command, '/usr/bin/ninja');
		assert.ok(calls.at(-1).args.includes('-j2'));
		assert.deepEqual(calls.at(-1).args.slice(-swiftLinkTargets.length), swiftLinkTargets);
		assert.deepEqual(
			receipt.swiftFrontendLinkLibraries.map((libraryPath) => path.basename(libraryPath)),
			swiftLinkTargets.map((target) => `lib${target}.a`)
		);
		assert.match(await readFile(receipt.toolchainPath, 'utf8'), /CMAKE_SYSTEM_NAME WASI/u);
		assert.equal(
			await readFile(
				path.join(nativeBuildDir, 'llvm-linux-x86_64/lib/clang/21/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a'),
				'utf8'
			),
			'builtins'
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
