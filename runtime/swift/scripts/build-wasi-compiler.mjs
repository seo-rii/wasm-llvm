#!/usr/bin/env node
import { access, copyFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const RUNTIME_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const LLVM_WASI_PATCH = path.join(RUNTIME_ROOT, 'patches', 'llvm-wasi-platform.patch');
const LLVM_WASI_THREAD_SHIM = path.join(RUNTIME_ROOT, 'patches', 'llvm-wasi-thread-shim.h');
const WASI_BUILD_TYPE = 'MinSizeRel';
const WASI_EMULATION_DEFINITIONS = [
	'_WASI_EMULATED_GETPID',
	'_WASI_EMULATED_MMAN',
	'_WASI_EMULATED_PROCESS_CLOCKS',
	'_WASI_EMULATED_SIGNAL'
];
const WASI_EMULATION_LIBRARIES = [
	'wasi-emulated-getpid',
	'wasi-emulated-mman',
	'wasi-emulated-process-clocks',
	'wasi-emulated-signal'
];
const SWIFT_FRONTEND_LINK_TARGETS = [
	'LLVMMCJIT',
	'LLVMOrcJIT',
	'LLVMExecutionEngine',
	'LLVMRuntimeDyld',
	'LLVMJITLink',
	'LLVMOrcTargetProcess',
	'LLVMOrcShared',
	'clangTooling',
	'clangToolingRefactor',
	'clangToolingRefactoring',
	'clangToolingSyntax'
];

function readOptionValue(argv, index, optionName) {
	const value = argv[index + 1];
	if (typeof value !== 'string' || !value || value.startsWith('--')) {
		throw new Error(`${optionName} requires a value`);
	}
	return value;
}

function runCommand(command, args, { cwd, capture = false } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
		});
		let stdout = '';
		let stderr = '';
		if (capture) {
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdout.on('data', (chunk) => {
				stdout += chunk;
			});
			child.stderr.on('data', (chunk) => {
				stderr += chunk;
			});
		}
		child.on('error', reject);
		child.on('close', (exitCode, signal) => {
			resolve({ exitCode, signal, stdout, stderr });
		});
	});
}

export async function inspectWasmOutput(filePath) {
	const handle = await open(filePath, 'r');
	try {
		const header = Buffer.alloc(8);
		const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
		const expected = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
		if (bytesRead !== expected.byteLength || !header.equals(expected)) {
			throw new Error(`${filePath} is not a WebAssembly 1.0 module`);
		}
		if (!WebAssembly.validate(await readFile(filePath))) {
			throw new Error(`${filePath} is not a valid WebAssembly module`);
		}
		const metadata = await handle.stat();
		return { path: filePath, bytes: metadata.size };
	} finally {
		await handle.close();
	}
}

export function parseBuildWasiCompilerArgs(argv) {
	const options = {
		sourceRoot: null,
		llvmSourceRoot: null,
		buildDir: null,
		nativeBuildDir: null,
		jobs: Math.max(1, cpus().length),
		execute: false,
		configureOnly: false,
		skipPatch: false,
		receiptPath: null
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--') continue;
		if (arg === '--help') return { help: true };
		if (arg === '--source-root') {
			options.sourceRoot = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--llvm-source-root') {
			options.llvmSourceRoot = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--build-dir') {
			options.buildDir = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--native-build-dir') {
			options.nativeBuildDir = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--jobs') {
			const jobs = Number(readOptionValue(argv, index, arg));
			if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error('--jobs must be a positive integer');
			options.jobs = jobs;
			index += 1;
		} else if (arg === '--receipt') {
			options.receiptPath = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--execute') options.execute = true;
		else if (arg === '--configure-only') options.configureOnly = true;
		else if (arg === '--skip-patch') options.skipPatch = true;
		else throw new Error(`Unknown option: ${arg}`);
	}
	if (!options.sourceRoot) throw new Error('--source-root is required');
	options.llvmSourceRoot ??= path.join(options.sourceRoot, 'llvm-project');
	options.buildDir ??= path.join(options.sourceRoot, 'browser-compiler-wasi');
	options.nativeBuildDir ??= path.join(options.sourceRoot, 'build', 'buildbot_linux');
	options.receiptPath ??= path.join(options.buildDir, 'wasm-idle-swift-wasi-compiler-build.json');
	return options;
}

export function createWasiToolchainSource({ nativeLlvmDir, wasiSysroot, threadShimPath = LLVM_WASI_THREAD_SHIM }) {
	const cmakePath = (value) => value.replaceAll('\\', '/').replaceAll('"', '\\"');
	const emulationFlags = WASI_EMULATION_DEFINITIONS.map((definition) => `-D${definition}`).join(' ');
	const emulationLibraries = WASI_EMULATION_LIBRARIES.map((library) => `-l${library}`).join(' ');
	return `set(CMAKE_SYSTEM_NAME WASI)
set(CMAKE_SYSTEM_PROCESSOR wasm32)

set(CMAKE_C_COMPILER "${cmakePath(path.join(nativeLlvmDir, 'bin', 'clang'))}")
set(CMAKE_CXX_COMPILER "${cmakePath(path.join(nativeLlvmDir, 'bin', 'clang++'))}")
set(CMAKE_C_COMPILER_TARGET "wasm32-wasip1")
set(CMAKE_CXX_COMPILER_TARGET "wasm32-wasip1")
set(CMAKE_SYSROOT "${cmakePath(wasiSysroot)}")
set(CMAKE_FIND_ROOT_PATH "\${CMAKE_SYSROOT}")
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)

set(CMAKE_C_FLAGS_INIT "${emulationFlags}")
set(CMAKE_CXX_FLAGS_INIT "${emulationFlags} -stdlib=libc++ -include ${cmakePath(threadShimPath)}")
set(CMAKE_EXE_LINKER_FLAGS_INIT "-Wl,--stack-first -Wl,-z,stack-size=8388608 -Wl,--initial-memory=268435456 -Wl,--max-memory=2147483648 -Wl,--export-memory ${emulationLibraries}")

set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
`;
}

export function createLlvmWasiConfigureCommand({ llvmSourceRoot, llvmBuildDir, toolchainPath, nativeLlvmDir }) {
	const emulationFlags = WASI_EMULATION_DEFINITIONS.map((definition) => `-D${definition}`).join(' ');
	const emulationLibraries = WASI_EMULATION_LIBRARIES.map((library) => `-l${library}`).join(' ');
	return [
		'/usr/bin/cmake', '-G', 'Ninja', '-S', path.join(llvmSourceRoot, 'llvm'), '-B', llvmBuildDir,
		`-DCMAKE_TOOLCHAIN_FILE=${toolchainPath}`, `-DCMAKE_BUILD_TYPE=${WASI_BUILD_TYPE}`, '-DLLVM_ENABLE_PROJECTS=clang;lld',
		'-UHAVE_SYS_MMAN_H', '-UHAVE_GETRUSAGE',
		`-DCMAKE_C_FLAGS=${emulationFlags}`,
		`-DCMAKE_CXX_FLAGS=${emulationFlags} -stdlib=libc++ -include ${LLVM_WASI_THREAD_SHIM}`,
		`-DCMAKE_EXE_LINKER_FLAGS=-Wl,--stack-first -Wl,-z,stack-size=8388608 -Wl,--initial-memory=268435456 -Wl,--max-memory=2147483648 -Wl,--export-memory ${emulationLibraries}`,
		'-DLLVM_TARGETS_TO_BUILD=WebAssembly', '-DLLVM_HOST_TRIPLE=wasm32-unknown-wasip1',
		'-DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-wasip1',
		`-DLLVM_TABLEGEN=${path.join(nativeLlvmDir, 'bin', 'llvm-tblgen')}`,
		`-DCLANG_TABLEGEN=${path.join(nativeLlvmDir, 'bin', 'clang-tblgen')}`,
		`-DLLVM_NATIVE_TOOL_DIR=${path.join(nativeLlvmDir, 'bin')}`,
		'-DLLVM_ENABLE_THREADS=OFF', '-DLLVM_ENABLE_ZLIB=OFF', '-DLLVM_ENABLE_ZSTD=OFF',
		'-DLLVM_ENABLE_LIBXML2=OFF', '-DLLVM_ENABLE_CURL=OFF', '-DLLVM_ENABLE_TERMINFO=OFF',
		'-DLLVM_ENABLE_LIBEDIT=OFF', '-DLLVM_ENABLE_LIBPFM=OFF', '-DLLVM_ENABLE_LIBCXX=OFF',
		'-DLLVM_ENABLE_PIC=OFF', '-DLLVM_BUILD_LLVM_DYLIB=OFF', '-DLLVM_LINK_LLVM_DYLIB=OFF',
		'-DBUILD_SHARED_LIBS=OFF', '-DLLVM_INCLUDE_TESTS=OFF', '-DCLANG_INCLUDE_TESTS=OFF',
		'-DLLVM_INCLUDE_EXAMPLES=OFF', '-DLLVM_INCLUDE_BENCHMARKS=OFF',
		'-DCLANG_ENABLE_STATIC_ANALYZER=OFF', '-DCLANG_ENABLE_OBJC_REWRITER=OFF',
		'-DLLVM_BUILD_TOOLS=ON', '-DLLVM_BUILD_UTILS=OFF'
	];
}

export async function buildWasiCompilerPrerequisites(
	options,
	{ run = runCommand, inspectOutput = inspectWasmOutput } = {}
) {
	const sourceRoot = path.resolve(options.sourceRoot);
	const llvmSourceRoot = path.resolve(options.llvmSourceRoot);
	const buildDir = path.resolve(options.buildDir);
	const nativeBuildDir = path.resolve(options.nativeBuildDir);
	const nativeLlvmDir = path.join(nativeBuildDir, 'llvm-linux-x86_64');
	const wasiSysroot = path.join(nativeBuildDir, 'wasi-sysroot', 'wasm32-wasip1', 'sysroot');
	const compilerRtBuiltins = path.join(
		nativeBuildDir,
		'wasmllvmruntimelibs-linux-x86_64',
		'wasm32-wasip1',
		'compiler-rt',
		'lib',
		'wasip1',
		'libclang_rt.builtins-wasm32.a'
	);
	const clangBuiltins = path.join(
		nativeLlvmDir,
		'lib',
		'clang',
		'21',
		'lib',
		'wasm32-unknown-wasip1',
		'libclang_rt.builtins.a'
	);
	const llvmBuildDir = path.join(buildDir, 'llvm-wasi');
	const toolchainPath = path.join(buildDir, 'swift-browser-wasi-toolchain.cmake');
	const configureCommand = createLlvmWasiConfigureCommand({ llvmSourceRoot, llvmBuildDir, toolchainPath, nativeLlvmDir });
	const buildCommand = [
		'/usr/bin/ninja', '-C', llvmBuildDir, `-j${options.jobs}`, 'clang', 'lld',
		...SWIFT_FRONTEND_LINK_TARGETS
	];
	const expectedOutputs = [path.join(llvmBuildDir, 'bin', 'clang'), path.join(llvmBuildDir, 'bin', 'lld')];
	const swiftFrontendLinkLibraries = SWIFT_FRONTEND_LINK_TARGETS.map((target) =>
		path.join(llvmBuildDir, 'lib', `lib${target}.a`)
	);
	const startedAt = new Date().toISOString();
	let status = options.execute ? 'passed' : 'dry-run';
	let patchStatus = options.skipPatch ? 'skipped' : 'pending';
	let errorMessage = null;
	let outputs = null;
	await mkdir(buildDir, { recursive: true });
	try {
		if (options.execute) {
			if (!options.skipPatch) {
				const reverseCheck = await run('git', ['apply', '--reverse', '--check', LLVM_WASI_PATCH], {
					cwd: llvmSourceRoot,
					capture: true
				});
				if (reverseCheck.exitCode === 0) patchStatus = 'already-applied';
				else {
					const apply = await run('git', ['apply', '--check', LLVM_WASI_PATCH], { cwd: llvmSourceRoot, capture: true });
					if (apply.exitCode !== 0) throw new Error(`LLVM WASI patch check failed:\n${apply.stderr}${apply.stdout}`);
					const applied = await run('git', ['apply', LLVM_WASI_PATCH], { cwd: llvmSourceRoot, capture: true });
					if (applied.exitCode !== 0) throw new Error(`LLVM WASI patch failed:\n${applied.stderr}${applied.stdout}`);
					patchStatus = 'applied';
				}
			}
			await mkdir(path.dirname(clangBuiltins), { recursive: true });
			await copyFile(compilerRtBuiltins, clangBuiltins);
			await writeFile(toolchainPath, createWasiToolchainSource({ nativeLlvmDir, wasiSysroot }), 'utf8');
			const configured = await run(configureCommand[0], configureCommand.slice(1));
			if (configured.exitCode !== 0) throw new Error(`LLVM WASI configure failed with ${configured.signal ?? configured.exitCode}`);
			if (!options.configureOnly) {
				const built = await run(buildCommand[0], buildCommand.slice(1));
				if (built.exitCode !== 0) throw new Error(`LLVM WASI build failed with ${built.signal ?? built.exitCode}`);
				await Promise.all(swiftFrontendLinkLibraries.map((libraryPath) => access(libraryPath)));
				outputs = await Promise.all(expectedOutputs.map((outputPath) => inspectOutput(outputPath)));
			}
		}
	} catch (error) {
		status = 'failed';
		errorMessage = error instanceof Error ? error.message : String(error);
	}
	const receipt = {
		format: 'wasm-idle-swift-wasi-compiler-build-v1',
		status,
		patchStatus,
		sourceRoot,
		llvmSourceRoot,
		buildDir,
		nativeBuildDir,
		wasiSysroot,
		toolchainPath,
		configureCommand,
		buildCommand,
		buildType: WASI_BUILD_TYPE,
		configureOnly: options.configureOnly,
		expectedOutputs,
		swiftFrontendLinkLibraries,
		outputs,
		startedAt,
		finishedAt: new Date().toISOString(),
		errorMessage
	};
	await mkdir(path.dirname(options.receiptPath), { recursive: true });
	await writeFile(options.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
	if (status === 'failed') throw new Error(errorMessage);
	return receipt;
}

function usage() {
	return `Usage: pnpm --dir runtime/swift run build:wasi-compiler -- --source-root <swift checkout> [options]

Configures and builds LLVM, Clang, and LLD as wasm32-wasip1 host tools for the real Swift browser compiler port.

Options:
  --build-dir <dir>         Browser compiler build root
  --llvm-source-root <dir>  Dedicated llvm-project checkout/worktree to patch
  --native-build-dir <dir>  Existing build-script native build root
  --jobs <n>                Ninja parallelism
  --receipt <file>          Build receipt path
  --execute                 Apply the port patch and run CMake/Ninja
  --configure-only          Stop after generating the LLVM WASI build
  --skip-patch              Do not apply or verify the LLVM WASI platform patch`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		const options = parseBuildWasiCompilerArgs(process.argv.slice(2));
		if (options.help) console.log(usage());
		else {
			const receipt = await buildWasiCompilerPrerequisites(options);
			console.log(`${receipt.status}: ${options.receiptPath}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
