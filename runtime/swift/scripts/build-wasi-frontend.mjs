#!/usr/bin/env node
import { access, mkdir, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { inspectWasmOutput } from './build-wasi-compiler.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const RUNTIME_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const SWIFT_WASI_PATCH = path.join(RUNTIME_ROOT, 'patches', 'swift-wasi-platform.patch');
const SWIFT_SYNTAX_WASI_PATCH = path.join(RUNTIME_ROOT, 'patches', 'swift-syntax-wasi-platform.patch');
const LLVM_WASI_THREAD_SHIM = path.join(RUNTIME_ROOT, 'patches', 'llvm-wasi-thread-shim.h');
const WASI_BUILD_TYPE = 'MinSizeRel';

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
			child.stdout.on('data', (chunk) => { stdout += chunk; });
			child.stderr.on('data', (chunk) => { stderr += chunk; });
		}
		child.on('error', reject);
		child.on('close', (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
	});
}

export function parseBuildWasiFrontendArgs(argv) {
	const options = {
		sourceRoot: null,
		swiftSourceRoot: null,
		swiftSyntaxSourceRoot: null,
		cmarkSourceRoot: null,
		llvmSourceRoot: null,
		buildDir: null,
		nativeBuildDir: null,
		llvmBuildDir: null,
		toolchainPath: null,
		jobs: Math.max(1, cpus().length),
		execute: false,
		configureOnly: false,
		swiftInSwift: true,
		skipPatch: false,
		receiptPath: null
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--') continue;
		if (arg === '--help') return { help: true };
		if (arg === '--source-root') options.sourceRoot = path.resolve(readOptionValue(argv, index++, arg));
		else if (arg === '--swift-source-root') options.swiftSourceRoot = path.resolve(readOptionValue(argv, index++, arg));
		else if (arg === '--swift-syntax-source-root') options.swiftSyntaxSourceRoot = path.resolve(readOptionValue(argv, index++, arg));
		else if (arg === '--cmark-source-root') options.cmarkSourceRoot = path.resolve(readOptionValue(argv, index++, arg));
		else if (arg === '--llvm-source-root') options.llvmSourceRoot = path.resolve(readOptionValue(argv, index++, arg));
		else if (arg === '--build-dir') options.buildDir = path.resolve(readOptionValue(argv, index++, arg));
		else if (arg === '--native-build-dir') options.nativeBuildDir = path.resolve(readOptionValue(argv, index++, arg));
		else if (arg === '--llvm-build-dir') options.llvmBuildDir = path.resolve(readOptionValue(argv, index++, arg));
		else if (arg === '--toolchain') options.toolchainPath = path.resolve(readOptionValue(argv, index++, arg));
		else if (arg === '--jobs') {
			const jobs = Number(readOptionValue(argv, index++, arg));
			if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error('--jobs must be a positive integer');
			options.jobs = jobs;
		} else if (arg === '--receipt') options.receiptPath = path.resolve(readOptionValue(argv, index++, arg));
		else if (arg === '--execute') options.execute = true;
		else if (arg === '--configure-only') options.configureOnly = true;
		else if (arg === '--swift-in-swift') options.swiftInSwift = true;
		else if (arg === '--cxx-bootstrap') options.swiftInSwift = false;
		else if (arg === '--skip-patch') options.skipPatch = true;
		else throw new Error(`Unknown option: ${arg}`);
	}
	if (!options.sourceRoot) throw new Error('--source-root is required');
	options.swiftSourceRoot ??= path.join(options.sourceRoot, 'swift');
	options.swiftSyntaxSourceRoot ??= path.join(options.sourceRoot, 'swift-syntax');
	options.cmarkSourceRoot ??= path.join(options.sourceRoot, 'cmark');
	options.llvmSourceRoot ??= path.join(options.sourceRoot, 'llvm-project');
	options.buildDir ??= path.join(options.sourceRoot, 'browser-compiler-wasi');
	options.nativeBuildDir ??= path.join(options.sourceRoot, 'build', 'buildbot_linux');
	options.llvmBuildDir ??= path.join(options.buildDir, 'llvm-wasi');
	options.toolchainPath ??= path.join(options.buildDir, 'swift-browser-wasi-toolchain.cmake');
	options.receiptPath ??= path.join(options.buildDir, 'wasm-idle-swift-wasi-frontend-build.json');
	return options;
}

export function createCmarkWasiCommands({ cmarkSourceRoot, cmarkBuildDir, toolchainPath, jobs }) {
	return {
		configure: [
			'/usr/bin/cmake', '-G', 'Ninja', '-S', cmarkSourceRoot, '-B', cmarkBuildDir,
			`-DCMAKE_TOOLCHAIN_FILE=${toolchainPath}`, `-DCMAKE_BUILD_TYPE=${WASI_BUILD_TYPE}`,
			'-DBUILD_SHARED_LIBS=OFF', '-DBUILD_TESTING=OFF', '-DCMARK_THREADING=OFF'
		],
		build: [
			'/usr/bin/ninja', '-C', cmarkBuildDir, `-j${jobs}`,
			'libcmark-gfm', 'libcmark-gfm-extensions'
		]
	};
}

export function createSwiftWasiCommands({
	swiftSourceRoot,
	swiftSyntaxSourceRoot,
	stringProcessingSourceRoot,
	cmarkSourceRoot,
	llvmSourceRoot,
	cmarkBuildDir,
	swiftBuildDir,
	llvmBuildDir,
	toolchainPath,
	nativeBuildDir,
	jobs,
	swiftInSwift
}) {
	const nativeLlvmTools = path.join(nativeBuildDir, 'llvm-linux-x86_64', 'bin');
	const nativeSwiftTools = path.join(nativeBuildDir, 'swift-linux-x86_64', 'bin');
	const wasiSysroot = path.join(nativeBuildDir, 'wasi-sysroot', 'wasm32-wasip1', 'sysroot');
	const swiftResourceDir = path.join(nativeBuildDir, 'wasmstdlib-linux-x86_64', 'lib', 'swift_static');
	const wasiSwiftRuntimeDir = path.join(swiftResourceDir, 'wasi');
	const wasiSwiftRuntimeObject = path.join(wasiSwiftRuntimeDir, 'wasm32', 'swiftrt.o');
	const wasiSwiftCoreLibrary = path.join(wasiSwiftRuntimeDir, 'wasm32', 'libswiftCore.a');
	const wasiThreadModuleHeader = path.join(swiftSourceRoot, 'include', 'swift', 'Basic', 'WASIThreadShim.h');
	const compilerModuleMaps = [
		path.join(wasiSysroot, 'include', 'c++', 'v1', 'module.modulemap'),
		path.join(swiftResourceDir, 'shims', 'module.modulemap'),
		path.join(swiftSyntaxSourceRoot, 'Sources', '_SwiftSyntaxCShims', 'include', 'module.modulemap'),
		path.join(swiftSyntaxSourceRoot, 'Sources', '_SwiftLibraryPluginProviderCShims', 'include', 'module.modulemap'),
		path.join(llvmBuildDir, 'include', 'module.modulemap'),
		path.join(swiftSourceRoot, 'include', 'module.modulemap')
	];
	const compilerSourceFlags = [
		'-sdk', wasiSysroot,
		'-resource-dir', swiftResourceDir,
		'-Xcc', '-fno-implicit-module-maps',
		'-Xcc', '-I', '-Xcc', path.dirname(LLVM_WASI_THREAD_SHIM),
		...compilerModuleMaps.flatMap((moduleMap) => ['-Xcc', `-fmodule-map-file=${moduleMap}`]),
		'-Xcc', '-include', '-Xcc', wasiThreadModuleHeader,
		'-Xcc', '-D_WASI_EMULATED_GETPID',
		'-Xcc', '-D_WASI_EMULATED_MMAN',
		'-Xcc', '-D_WASI_EMULATED_PROCESS_CLOCKS',
		'-Xcc', '-D_WASI_EMULATED_SIGNAL'
	];
	const swiftLanguageOptions = swiftInSwift
		? [
			`-DSWIFT_PATH_TO_SWIFT_SYNTAX_SOURCE=${swiftSyntaxSourceRoot}`,
			`-DSWIFT_PATH_TO_STRING_PROCESSING_SOURCE=${stringProcessingSourceRoot}`,
			'-DSWIFT_BUILD_SWIFT_SYNTAX=ON',
			'-DSWIFT_ENABLE_SWIFT_IN_SWIFT=ON',
			'-DBRIDGING_MODE=PURE',
			'-DBOOTSTRAPPING_MODE=HOSTTOOLS'
		]
		: [
			'-DSWIFT_BUILD_SWIFT_SYNTAX=OFF',
			'-DSWIFT_ENABLE_SWIFT_IN_SWIFT=OFF',
			'-DBOOTSTRAPPING_MODE=OFF'
		];
	return {
		configure: [
			'/usr/bin/cmake', '-G', 'Ninja', '-S', swiftSourceRoot, '-B', swiftBuildDir,
			`-DCMAKE_TOOLCHAIN_FILE=${toolchainPath}`, `-DCMAKE_BUILD_TYPE=${WASI_BUILD_TYPE}`,
			`-DCMAKE_Swift_COMPILER=${path.join(nativeSwiftTools, 'swiftc')}`,
			'-DCMAKE_Swift_COMPILER_TARGET=wasm32-unknown-wasip1',
			`-DCMAKE_Swift_FLAGS=${compilerSourceFlags.join(' ')}`,
			`-DSWIFT_COMPILER_SOURCES_SDK_FLAGS=${compilerSourceFlags.join(';')}`,
			`-DLLVM_DIR=${path.join(llvmBuildDir, 'lib', 'cmake', 'llvm')}`,
			`-DClang_DIR=${path.join(llvmBuildDir, 'lib', 'cmake', 'clang')}`,
			`-DLLVM_TABLEGEN=${path.join(nativeLlvmTools, 'llvm-tblgen')}`,
			`-DSWIFT_NATIVE_LLVM_TOOLS_PATH=${nativeLlvmTools}`,
			`-DSWIFT_NATIVE_CLANG_TOOLS_PATH=${nativeLlvmTools}`,
			`-DSWIFT_NATIVE_SWIFT_TOOLS_PATH=${nativeSwiftTools}`,
			`-DSWIFT_PATH_TO_CMARK_SOURCE=${cmarkSourceRoot}`,
			`-DSWIFT_PATH_TO_CMARK_BUILD=${cmarkBuildDir}`,
			`-DSWIFT_WASI_SYSROOT_PATH=${wasiSysroot}`,
			`-DSWIFT_WASI_HOST_LIBRARIES_PATH=${wasiSwiftRuntimeDir}`,
			`-DSWIFT_WASI_HOST_SWIFTRT_PATH=${wasiSwiftRuntimeObject}`,
			'-DSWIFT_HOST_VARIANT_SDK=WASI', '-DSWIFT_HOST_VARIANT_ARCH=wasm32',
			'-DSWIFT_PRIMARY_VARIANT_SDK=WASI', '-DSWIFT_PRIMARY_VARIANT_ARCH=wasm32',
			'-DSWIFT_SDKS=WASI', '-DSWIFT_USE_LINKER=lld',
			'-DSWIFT_INCLUDE_TOOLS=ON', '-DSWIFT_INCLUDE_TESTS=OFF',
			'-DSWIFT_INCLUDE_TEST_BINARIES=OFF', '-DSWIFT_INCLUDE_DOCS=OFF',
			'-DSWIFT_BUILD_DYNAMIC_STDLIB=OFF', '-DSWIFT_BUILD_STATIC_STDLIB=OFF',
			'-DSWIFT_BUILD_DYNAMIC_SDK_OVERLAY=OFF', '-DSWIFT_BUILD_STATIC_SDK_OVERLAY=OFF',
			'-DSWIFT_BUILD_SOURCEKIT=OFF', '-DSWIFT_BUILD_REMOTE_MIRROR=OFF',
			'-DSWIFT_ENABLE_DISPATCH=OFF',
			...swiftLanguageOptions
		],
		build: ['/usr/bin/ninja', '-C', swiftBuildDir, `-j${jobs}`, 'swift-frontend'],
		wasiSysroot,
		swiftResourceDir,
		threadShimPath: LLVM_WASI_THREAD_SHIM,
		wasiThreadModuleHeader,
		compilerModuleMaps,
		wasiSwiftRuntimeObject,
		wasiSwiftCoreLibrary
	};
}

async function applySwiftWasiPatch(swiftSourceRoot, run) {
	const reverseCheck = await run('git', ['apply', '--reverse', '--check', SWIFT_WASI_PATCH], {
		cwd: swiftSourceRoot,
		capture: true
	});
	if (reverseCheck.exitCode === 0) return 'already-applied';
	const check = await run('git', ['apply', '--check', SWIFT_WASI_PATCH], {
		cwd: swiftSourceRoot,
		capture: true
	});
	if (check.exitCode !== 0) throw new Error(`Swift WASI patch check failed:\n${check.stderr}${check.stdout}`);
	const applied = await run('git', ['apply', SWIFT_WASI_PATCH], { cwd: swiftSourceRoot, capture: true });
	if (applied.exitCode !== 0) throw new Error(`Swift WASI patch failed:\n${applied.stderr}${applied.stdout}`);
	return 'applied';
}

async function applySwiftSyntaxWasiPatch(swiftSyntaxSourceRoot, run) {
	const reverseCheck = await run('git', ['apply', '--reverse', '--check', SWIFT_SYNTAX_WASI_PATCH], {
		cwd: swiftSyntaxSourceRoot,
		capture: true
	});
	if (reverseCheck.exitCode === 0) return 'already-applied';
	const check = await run('git', ['apply', '--check', SWIFT_SYNTAX_WASI_PATCH], {
		cwd: swiftSyntaxSourceRoot,
		capture: true
	});
	if (check.exitCode !== 0) throw new Error(`SwiftSyntax WASI patch check failed:\n${check.stderr}${check.stdout}`);
	const applied = await run('git', ['apply', SWIFT_SYNTAX_WASI_PATCH], {
		cwd: swiftSyntaxSourceRoot,
		capture: true
	});
	if (applied.exitCode !== 0) throw new Error(`SwiftSyntax WASI patch failed:\n${applied.stderr}${applied.stdout}`);
	return 'applied';
}

async function runChecked(command, run) {
	const result = await run(command[0], command.slice(1));
	if (result.exitCode !== 0) throw new Error(`${path.basename(command[0])} failed with ${result.signal ?? result.exitCode}`);
}

export async function buildWasiFrontend(
	options,
	{ run = runCommand, inspectOutput = inspectWasmOutput, checkAccess = access } = {}
) {
	const cmarkBuildDir = path.join(options.buildDir, 'cmark-wasi');
	const swiftBuildDir = path.join(options.buildDir, 'swift-wasi');
	const stringProcessingSourceRoot = path.join(options.sourceRoot, 'swift-experimental-string-processing');
	const cmarkCommands = createCmarkWasiCommands({
		cmarkSourceRoot: options.cmarkSourceRoot,
		cmarkBuildDir,
		toolchainPath: options.toolchainPath,
		jobs: options.jobs
	});
	const swiftCommands = createSwiftWasiCommands({
		swiftSourceRoot: options.swiftSourceRoot,
		swiftSyntaxSourceRoot: options.swiftSyntaxSourceRoot,
		stringProcessingSourceRoot,
		cmarkSourceRoot: options.cmarkSourceRoot,
		llvmSourceRoot: options.llvmSourceRoot,
		cmarkBuildDir,
		swiftBuildDir,
		llvmBuildDir: options.llvmBuildDir,
		toolchainPath: options.toolchainPath,
		nativeBuildDir: options.nativeBuildDir,
		jobs: options.jobs,
		swiftInSwift: options.swiftInSwift
	});
	const expectedOutput = path.join(swiftBuildDir, 'bin', 'swift-frontend');
	const startedAt = new Date().toISOString();
	let status = options.execute ? 'passed' : 'dry-run';
	let patchStatus = options.skipPatch ? 'skipped' : 'pending';
	let swiftSyntaxPatchStatus = options.skipPatch ? 'skipped' : 'pending';
	let output = null;
	let errorMessage = null;
	await mkdir(options.buildDir, { recursive: true });
	try {
		if (options.execute) {
			await checkAccess(options.toolchainPath);
			await checkAccess(swiftCommands.threadShimPath);
			await checkAccess(stringProcessingSourceRoot);
			await checkAccess(swiftCommands.wasiSwiftRuntimeObject);
			await checkAccess(swiftCommands.wasiSwiftCoreLibrary);
			if (!options.skipPatch) {
				patchStatus = await applySwiftWasiPatch(options.swiftSourceRoot, run);
				swiftSyntaxPatchStatus = await applySwiftSyntaxWasiPatch(options.swiftSyntaxSourceRoot, run);
			}
			await checkAccess(swiftCommands.wasiThreadModuleHeader);
			for (const moduleMap of swiftCommands.compilerModuleMaps) await checkAccess(moduleMap);
			await runChecked(cmarkCommands.configure, run);
			if (!options.configureOnly) await runChecked(cmarkCommands.build, run);
			await runChecked(swiftCommands.configure, run);
			if (!options.configureOnly) {
				await runChecked(swiftCommands.build, run);
				output = await inspectOutput(expectedOutput);
			}
		}
	} catch (error) {
		status = 'failed';
		errorMessage = error instanceof Error ? error.message : String(error);
	}
	const receipt = {
		format: 'wasm-idle-swift-wasi-frontend-build-v1',
		status,
		patchStatus,
		swiftSyntaxPatchStatus,
		buildType: WASI_BUILD_TYPE,
		compilerCompleteness: options.swiftInSwift ? 'upstream-swift-in-swift' : 'cxx-frontend-bootstrap',
		swiftInSwift: options.swiftInSwift,
		macroPluginLoading: options.swiftInSwift ? 'static-registration-required' : 'not-built',
		configureOnly: options.configureOnly,
		sourceRoot: options.sourceRoot,
		swiftSourceRoot: options.swiftSourceRoot,
		swiftSyntaxSourceRoot: options.swiftSyntaxSourceRoot,
		stringProcessingSourceRoot,
		cmarkSourceRoot: options.cmarkSourceRoot,
		llvmSourceRoot: options.llvmSourceRoot,
		buildDir: options.buildDir,
		nativeBuildDir: options.nativeBuildDir,
		llvmBuildDir: options.llvmBuildDir,
		toolchainPath: options.toolchainPath,
		cmarkBuildDir,
		swiftBuildDir,
		wasiSysroot: swiftCommands.wasiSysroot,
		swiftResourceDir: swiftCommands.swiftResourceDir,
		threadShimPath: swiftCommands.threadShimPath,
		wasiThreadModuleHeader: swiftCommands.wasiThreadModuleHeader,
		compilerModuleMaps: swiftCommands.compilerModuleMaps,
		wasiSwiftRuntimeObject: swiftCommands.wasiSwiftRuntimeObject,
		wasiSwiftCoreLibrary: swiftCommands.wasiSwiftCoreLibrary,
		commands: { cmark: cmarkCommands, swift: swiftCommands },
		expectedOutput,
		output,
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
	return `Usage: pnpm --dir runtime/swift run build:wasi-frontend -- --source-root <swift checkout> [options]

Builds cmark-gfm and the upstream Swift frontend as wasm32-wasip1 host tools.

Options:
  --swift-source-root <dir>  Dedicated Swift checkout/worktree to patch
  --swift-syntax-source-root <dir>
                              Matching swift-syntax checkout
  --cmark-source-root <dir>  cmark-gfm source checkout
  --llvm-source-root <dir>   llvm-project checkout used by the WASI build
  --build-dir <dir>          Shared browser compiler build root
  --native-build-dir <dir>   Existing build-script native build root
  --llvm-build-dir <dir>     Completed LLVM WASI build directory
  --toolchain <file>         CMake WASI toolchain from build:wasi-compiler
  --jobs <n>                 Ninja parallelism
  --receipt <file>           Build receipt path
  --execute                  Apply the port patch and run CMake/Ninja
  --configure-only           Generate cmark and Swift build graphs only
  --swift-in-swift           Include upstream Swift parser and Swift compiler modules (default)
  --cxx-bootstrap            Build only the upstream C++ frontend investigation stage
  --skip-patch               Do not apply or verify the Swift WASI patch`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		const options = parseBuildWasiFrontendArgs(process.argv.slice(2));
		if (options.help) console.log(usage());
		else {
			const receipt = await buildWasiFrontend(options);
			console.log(`${receipt.status}: ${options.receiptPath}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
