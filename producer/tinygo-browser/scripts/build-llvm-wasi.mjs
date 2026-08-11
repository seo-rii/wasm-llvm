#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const PRODUCER_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const RECEIPT_FORMAT = 'wasm-llvm-tinygo-llvm-wasi-static-v1';
const PATCHED_PATHS = [
	'clang/include/clang/Support/Compiler.h',
	'clang/tools/libclang/CIndexer.cpp',
	'llvm/cmake/config-ix.cmake',
	'llvm/include/llvm/Support/Compiler.h',
	'llvm/lib/Support/CrashRecoveryContext.cpp',
	'llvm/lib/Support/Signals.cpp',
	'llvm/lib/Support/Unix/Process.inc',
	'llvm/lib/Support/Unix/Program.inc'
];
const UPSTREAM_PATCHED_PATHS = [
	'clang/include/clang/Support/Compiler.h',
	'clang/lib/Driver/Driver.cpp',
	'llvm/cmake/config-ix.cmake',
	'llvm/cmake/modules/HandleLLVMOptions.cmake',
	'llvm/include/llvm/ADT/bit.h',
	'llvm/include/llvm/Config/config.h.cmake',
	'llvm/include/llvm/Support/Compiler.h',
	'llvm/lib/ExecutionEngine/Interpreter/ExternalFunctions.cpp',
	'llvm/lib/Support/CrashRecoveryContext.cpp',
	'llvm/lib/Support/InitLLVM.cpp',
	'llvm/lib/Support/LockFileManager.cpp',
	'llvm/lib/Support/Signals.cpp',
	'llvm/lib/Support/Unix/Memory.inc',
	'llvm/lib/Support/Unix/Path.inc',
	'llvm/lib/Support/Unix/Process.inc',
	'llvm/lib/Support/Unix/Program.inc',
	'llvm/lib/Support/Unix/Unix.h',
	'llvm/lib/Support/Unix/Watchdog.inc',
	'llvm/lib/Support/raw_socket_stream.cpp'
];
const UPSTREAM_EXCLUDED_PATHS = [
	'clang/include/clang/Support/Compiler.h',
	'llvm/include/llvm/Support/Compiler.h',
	'llvm/lib/Support/CrashRecoveryContext.cpp',
	'llvm/lib/Support/Unix/Program.inc'
];
const REQUIRED_PROJECTS = ['clang', 'lld'];
const REQUIRED_NATIVE_TOOLS = ['llvm-tblgen', 'clang-tblgen'];
const REQUIRED_HEADER_NAMES = [
	'clang-c/Index.h',
	'llvm-c/Core.h',
	'llvm/Config/llvm-config.h'
];
const REQUIRED_COMPILER_RUNTIME_SYMBOLS = ['__multi3', '__udivti3'];
const HOST_SUPPORT_ARCHIVES = [
	{
		id: 'tinygo-builder-cxx',
		sources: ['builder/cc1as.cpp', 'builder/clang.cpp', 'builder/lld.cpp'],
		requiredSymbols: ['tinygo_clang_driver', 'tinygo_link', 'tinygo_validate_wasm_object']
	},
	{
		id: 'go-llvm-cxx',
		sources: ['IRBindings.cpp', 'SupportBindings.cpp', 'backports.cpp'],
		requiredSymbols: [
			'LLVMConstantAsMetadata',
			'LLVMLoadLibraryPermanently2',
			'LLVMGoWriteThinLTOBitcodeToMemoryBuffer'
		]
	}
];

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function runCommand(command, args, { cwd, capture = false, env } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: env ? { ...process.env, ...env } : process.env,
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

export function parseBuildLlvmWasiArgs(argv) {
	const options = {
		sourceRoot: null,
		wasiSdk: null,
		nativeToolDir: null,
		buildDir: null,
		receiptPath: null,
		jobs: Math.max(1, Math.min(4, cpus().length)),
		checkPatch: false,
		execute: false,
		configureOnly: false
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--') continue;
		if (argument === '--help' || argument === '-h') return { help: true };
		if (
			argument === '--source-root' ||
			argument === '--wasi-sdk' ||
			argument === '--native-tool-dir' ||
			argument === '--build-dir' ||
			argument === '--receipt' ||
			argument === '--jobs'
		) {
			const value = argv[index + 1];
			if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
			if (argument === '--jobs') {
				const jobs = Number(value);
				if (!Number.isSafeInteger(jobs) || jobs < 1) {
					throw new Error('--jobs must be a positive integer');
				}
				options.jobs = jobs;
			} else {
				const key = {
					'--source-root': 'sourceRoot',
					'--wasi-sdk': 'wasiSdk',
					'--native-tool-dir': 'nativeToolDir',
					'--build-dir': 'buildDir',
					'--receipt': 'receiptPath'
				}[argument];
				options[key] = path.resolve(value);
			}
			index += 1;
		} else if (argument === '--check-patch') options.checkPatch = true;
		else if (argument === '--execute') options.execute = true;
		else if (argument === '--configure-only') options.configureOnly = true;
		else throw new Error(`Unknown option: ${argument}`);
	}
	if (!options.sourceRoot) throw new Error('--source-root is required');
	if (!options.wasiSdk) throw new Error('--wasi-sdk is required');
	if (!options.nativeToolDir) throw new Error('--native-tool-dir is required');
	if (options.checkPatch && options.execute) {
		throw new Error('--check-patch and --execute are mutually exclusive');
	}
	if (options.configureOnly && !options.execute) {
		throw new Error('--configure-only requires --execute');
	}
	options.buildDir ??= path.join(path.dirname(options.sourceRoot), 'tinygo-llvm-wasi-build');
	options.receiptPath ??= path.join(options.buildDir, 'tinygo-llvm-wasi-build.json');
	return options;
}

export function createTinyGoLlvmWasiToolchain({ wasiSdk, config }) {
	const cmakePath = (value) => value.replaceAll('\\', '/').replaceAll('"', '\\"');
	const binDir = path.join(wasiSdk, 'bin');
	const sysroot = path.join(wasiSdk, 'share', 'wasi-sysroot');
	const definitions = config.wasi.emulationDefinitions
		.map((definition) => `-D${definition}`)
		.join(' ');
	return `# Generated by wasm-llvm TinyGo LLVM WASI producer.
set(CMAKE_SYSTEM_NAME WASI)
set(CMAKE_SYSTEM_VERSION 1)
set(CMAKE_SYSTEM_PROCESSOR wasm32)

set(CMAKE_C_COMPILER "${cmakePath(path.join(binDir, 'clang'))}")
set(CMAKE_CXX_COMPILER "${cmakePath(path.join(binDir, 'clang++'))}")
set(CMAKE_ASM_COMPILER "${cmakePath(path.join(binDir, 'clang'))}")
set(CMAKE_AR "${cmakePath(path.join(binDir, 'llvm-ar'))}")
set(CMAKE_RANLIB "${cmakePath(path.join(binDir, 'llvm-ranlib'))}")
set(CMAKE_C_COMPILER_TARGET "${config.host.compilerTarget}")
set(CMAKE_CXX_COMPILER_TARGET "${config.host.compilerTarget}")
set(CMAKE_ASM_COMPILER_TARGET "${config.host.compilerTarget}")
set(CMAKE_SYSROOT "${cmakePath(sysroot)}")
set(CMAKE_FIND_ROOT_PATH "\${CMAKE_SYSROOT}")
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)

set(CMAKE_C_FLAGS_INIT "${definitions}")
set(CMAKE_CXX_FLAGS_INIT "${definitions} -stdlib=libc++ -fno-exceptions -fno-rtti")

set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
`;
}

export async function createTinyGoLlvmWasiBuildPlan(
	options,
	{ producerRoot = PRODUCER_ROOT } = {}
) {
	const configPath = path.join(producerRoot, 'config', 'llvm-wasi-static.json');
	const sourcesLockPath = path.join(producerRoot, 'sources.lock.json');
	const scriptPath = path.join(producerRoot, 'scripts', 'build-llvm-wasi.mjs');
	const [configBytes, sourcesLockBytes, scriptBytes] = await Promise.all([
		readFile(configPath),
		readFile(sourcesLockPath),
		readFile(scriptPath)
	]);
	const config = JSON.parse(configBytes);
	const sourcesLock = JSON.parse(sourcesLockBytes);
	assert(config.schemaVersion === 1, 'LLVM WASI config must use schemaVersion 1');
	assert(config.planId === 'tinygo-llvm-wasi-static-v1', 'unexpected LLVM WASI plan id');
	assert(
		JSON.stringify(config.source) === JSON.stringify(sourcesLock.llvm),
		'LLVM WASI config source does not match TinyGo sources.lock.json'
	);
	assert(
		JSON.stringify(config.upstreamPatch) === JSON.stringify(sourcesLock.wasiHostPatch),
		'LLVM WASI upstream host patch does not match TinyGo sources.lock.json'
	);
	assert(
		JSON.stringify(config.upstreamPatch.expectedPaths) ===
			JSON.stringify(UPSTREAM_PATCHED_PATHS),
		'unexpected YoWASP LLVM WASI host patch scope'
	);
	assert(
		JSON.stringify(config.upstreamPatch.excludedPaths) ===
			JSON.stringify(UPSTREAM_EXCLUDED_PATHS),
		'unexpected TinyGo LLVM WASI host patch exclusions'
	);
	assert(
		/^[0-9a-f]{40}$/u.test(config.upstreamPatch.commit) &&
			/^[0-9a-f]{40}$/u.test(config.upstreamPatch.parent) &&
			config.upstreamPatch.commit !== config.upstreamPatch.parent,
		'upstream LLVM WASI host patch must pin distinct full commits'
	);
	assert(config.host?.compilerTarget === 'wasm32-wasip1', 'compiler target must be wasm32-wasip1');
	assert(config.host?.llvmTriple === 'wasm32-unknown-wasi', 'unexpected LLVM host triple');
	assert(
		JSON.stringify(config.host?.targetsToBuild) === JSON.stringify(['WebAssembly']),
		'only the WebAssembly LLVM target may be built'
	);
	assert(
		JSON.stringify(config.build?.projects) === JSON.stringify(REQUIRED_PROJECTS),
		'the browser compiler host requires the real Clang and LLD projects'
	);
	assert(
		Array.isArray(config.build?.archiveTargets) && config.build.archiveTargets.length > 0,
		'the static Clang, LLD, and LLVM archive closure is required'
	);
	assert(
		new Set(config.build.archiveTargets).size === config.build.archiveTargets.length,
		'static LLVM archive targets must be unique'
	);
	assert(
		config.build.archiveTargets.every((target) =>
			/^(?:libclang|clang[A-Za-z0-9]+|lld[A-Za-z0-9]+|LLVM[A-Za-z0-9]+)$/u.test(
				target
			)
		),
		'archive targets must be Clang, LLD, or LLVM static libraries'
	);
	assert(
		config.build.archiveTargets[0] === 'libclang' &&
			config.build.archiveTargets.includes('clangDriver') &&
			config.build.archiveTargets.includes('lldWasm') &&
			config.build.archiveTargets.includes('LLVMCore') &&
			config.build.archiveTargets.includes('LLVMSupport') &&
			config.build.archiveTargets.includes('LLVMWebAssemblyCodeGen'),
		'libclang, Clang driver, LLD Wasm, and go-llvm archives are required'
	);
	assert(
		JSON.stringify(config.build.requiredNativeTools) ===
			JSON.stringify(REQUIRED_NATIVE_TOOLS),
		'the cross build must use native llvm-tblgen and clang-tblgen'
	);
	const libclangConfig = config.build.libclang;
	assert(
		libclangConfig?.target === 'libclang' && libclangConfig.archiveFile === 'libclang.a',
		'the static libclang target and archive name are required'
	);
	assert(
		JSON.stringify(libclangConfig.requiredHeaders?.map((header) => header.name)) ===
			JSON.stringify(REQUIRED_HEADER_NAMES),
		'libclang and go-llvm require the Clang C API, LLVM C API, and generated LLVM config headers'
	);
	assert(
		libclangConfig.requiredHeaders.every(
			(header) =>
				(header.origin === 'source' || header.origin === 'build') &&
				typeof header.relativePath === 'string' &&
				header.relativePath.length > 0 &&
				!path.isAbsolute(header.relativePath)
		),
		'required LLVM headers must have source/build-relative paths'
	);
	const hostSupportConfig = config.build.hostSupport;
	assert(
		hostSupportConfig?.mode === 'consumer-compiled-upstream-cxx' &&
			hostSupportConfig.cxxStandard === 'c++17' &&
			hostSupportConfig.allowStubSymbols === false,
		'TinyGo built-in Clang and LLD support must use upstream C++ without stubs'
	);
	assert(
		JSON.stringify(hostSupportConfig.archives) ===
			JSON.stringify(HOST_SUPPORT_ARCHIVES),
		'TinyGo and go-llvm host support archives differ from the upstream source and symbol contract'
	);
	assert(
		JSON.stringify(hostSupportConfig.definitions) ===
			JSON.stringify(['CINDEX_NO_EXPORTS']),
		'TinyGo host support must compile without importing libclang exports'
	);
	assert(
		Array.isArray(config.wasi?.emulationDefinitions) &&
			config.wasi.emulationDefinitions.length > 0,
		'WASI emulation definitions are required'
	);
	assert(
		Array.isArray(config.wasi?.finalLinkLibraries) &&
			config.wasi.finalLinkLibraries.includes('dl') &&
			config.wasi.finalLinkLibraries.includes('c++') &&
			config.wasi.finalLinkLibraries.includes('c++abi'),
		'final Clang/go-llvm linkage must include libdl, libc++, and libc++abi'
	);
	const patchPath = path.join(producerRoot, config.patch.path);
	const patchBytes = await readFile(patchPath);
	const patchSha256 = createHash('sha256').update(patchBytes).digest('hex');
	const lockedPatch = sourcesLock.patches?.find((entry) => entry.path === config.patch.path);
	assert(lockedPatch, `${config.patch.path} is not registered in TinyGo sources.lock.json`);
	assert(
		patchSha256 === config.patch.sha256 && patchSha256 === lockedPatch.sha256,
		`LLVM WASI patch checksum mismatch: config ${config.patch.sha256}, lock ${lockedPatch.sha256}, received ${patchSha256}`
	);
	const patchSource = patchBytes.toString('utf8');
	const patchedPaths = [...patchSource.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gmu)].map(
		(match) => {
			assert(match[1] === match[2], 'LLVM WASI patch renames a source file');
			return match[1];
		}
	);
	assert(
		JSON.stringify(patchedPaths) === JSON.stringify(PATCHED_PATHS),
		'LLVM WASI TinyGo port patch contains files outside its locked compatibility scope'
	);
	assert(
		!/(?:^|\n)diff --git a\/(?:clang\/lib\/(?!Driver\/Driver\.cpp)|lld\/)/u.test(
			patchSource
		),
		'TinyGo port patch must not modify Clang or LLD compiler semantics'
	);

	const sourceRoot = path.resolve(options.sourceRoot);
	const buildDir = path.resolve(options.buildDir);
	const upstreamPatchPath = path.join(buildDir, 'yowasp-llvm-wasi-host.patch');
	const toolchainPath = path.join(buildDir, 'tinygo-llvm-wasi-toolchain.cmake');
	const toolchainSource = createTinyGoLlvmWasiToolchain({
		wasiSdk: path.resolve(options.wasiSdk),
		config
	});
	const llvmBuildDir = path.join(buildDir, 'llvm');
	const nativeTablegen = path.join(path.resolve(options.nativeToolDir), 'llvm-tblgen');
	const nativeClangTablegen = path.join(path.resolve(options.nativeToolDir), 'clang-tblgen');
	const configureCommand = [
		'cmake',
		'-G',
		'Ninja',
		'-S',
		path.join(sourceRoot, 'llvm'),
		'-B',
		llvmBuildDir,
		`-DCMAKE_TOOLCHAIN_FILE=${toolchainPath}`,
		`-DCMAKE_BUILD_TYPE=${config.build.type}`,
		`-DLLVM_HOST_TRIPLE=${config.host.llvmTriple}`,
		`-DLLVM_DEFAULT_TARGET_TRIPLE=${config.host.llvmTriple}`,
		`-DLLVM_TARGETS_TO_BUILD=${config.host.targetsToBuild.join(';')}`,
		`-DLLVM_ENABLE_PROJECTS=${config.build.projects.join(';')}`,
		`-DLLVM_TABLEGEN=${nativeTablegen}`,
		`-DCLANG_TABLEGEN=${nativeClangTablegen}`,
		`-DLLVM_NATIVE_TOOL_DIR=${path.resolve(options.nativeToolDir)}`,
		'-DLLVM_ENABLE_THREADS=OFF',
		'-DLLVM_ENABLE_BACKTRACES=OFF',
		'-DLLVM_ENABLE_BINDINGS=OFF',
		'-DLLVM_ENABLE_CRASH_OVERRIDES=OFF',
		'-DLLVM_ENABLE_EH=OFF',
		'-DLLVM_ENABLE_LIBEDIT=OFF',
		'-DLLVM_ENABLE_LIBXML2=OFF',
		'-DLLVM_ENABLE_PIC=OFF',
		'-DLLVM_ENABLE_RTTI=OFF',
		'-DLLVM_ENABLE_TERMINFO=OFF',
		'-DLLVM_ENABLE_UNWIND_TABLES=OFF',
		'-DLLVM_ENABLE_ZLIB=OFF',
		'-DLLVM_ENABLE_ZSTD=OFF',
		'-DLLVM_BUILD_LLVM_DYLIB=OFF',
		'-DLLVM_LINK_LLVM_DYLIB=OFF',
		'-DBUILD_SHARED_LIBS=OFF',
		'-DLLVM_BUILD_TOOLS=OFF',
		'-DLLVM_BUILD_UTILS=OFF',
		'-DCLANG_BUILD_TOOLS=OFF',
		'-DCLANG_INCLUDE_TESTS=OFF',
		'-DCLANG_ENABLE_ARCMT=OFF',
		'-DCLANG_ENABLE_STATIC_ANALYZER=OFF',
		'-DCLANG_ENABLE_HLSL=OFF',
		'-DCLANG_PLUGIN_SUPPORT=OFF',
		'-DLIBCLANG_BUILD_STATIC=ON',
		'-DLLD_BUILD_TOOLS=OFF',
		'-DLLD_INCLUDE_TESTS=OFF',
		'-DLLVM_INCLUDE_DOCS=OFF',
		'-DLLVM_INCLUDE_EXAMPLES=OFF',
		'-DLLVM_INCLUDE_TESTS=OFF',
		'-DLLVM_INCLUDE_BENCHMARKS=OFF',
		'-DLLVM_INCLUDE_RUNTIMES=OFF',
		'-UHAVE_SYS_MMAN_H',
		'-UHAVE_GETRUSAGE'
	];
	const buildCommand = [
		'cmake',
		'--build',
		llvmBuildDir,
		'--target',
		...config.build.archiveTargets,
		'--parallel',
		String(options.jobs)
	];
	const expectedArchives = config.build.archiveTargets.map((target) => ({
		target,
		path: path.join(
			llvmBuildDir,
			'lib',
			target === libclangConfig.target
				? libclangConfig.archiveFile
				: `lib${target}.a`
		)
	}));
	const requiredHeaders = libclangConfig.requiredHeaders.map((header) => ({
		name: header.name,
		path: path.join(
			header.origin === 'source' ? sourceRoot : llvmBuildDir,
			header.relativePath
		)
	}));
	const clangIncludeRoot = path.join(sourceRoot, 'clang', 'include');
	const hostSupportIncludeRoots = [
		path.join(sourceRoot, 'llvm', 'include'),
		path.join(llvmBuildDir, 'include'),
		clangIncludeRoot,
		path.join(llvmBuildDir, 'tools', 'clang', 'include'),
		path.join(sourceRoot, 'lld', 'include'),
		path.join(llvmBuildDir, 'tools', 'lld', 'include')
	];
	const libclangArchive = expectedArchives.find(
		(output) => output.target === libclangConfig.target
	);
	const wasiSdk = path.resolve(options.wasiSdk);
	const wasiSysroot = path.join(wasiSdk, 'share', 'wasi-sysroot');
	return {
		format: RECEIPT_FORMAT,
		status: 'dry-run',
		upstreamPatchStatus: 'pending',
		patchStatus: 'pending',
		inputs: {
			configSha256: createHash('sha256').update(configBytes).digest('hex'),
			sourcesLockSha256: createHash('sha256').update(sourcesLockBytes).digest('hex'),
			producerScriptSha256: createHash('sha256').update(scriptBytes).digest('hex'),
			patchSha256,
			upstreamPatchCommit: config.upstreamPatch.commit,
			upstreamPatchParent: config.upstreamPatch.parent
		},
		source: config.source,
		upstreamPatch: config.upstreamPatch,
		host: config.host,
		projects: [...config.build.projects],
		paths: {
			sourceRoot,
			buildDir,
			llvmBuildDir,
			wasiSdk,
			wasiSysroot,
			nativeToolDir: path.resolve(options.nativeToolDir),
			toolchainPath,
			patchPath,
			upstreamPatchPath
		},
		buildType: config.build.type,
		jobs: options.jobs,
		configureOnly: options.configureOnly,
		toolchainSha256: createHash('sha256').update(toolchainSource).digest('hex'),
		toolchainSource,
		configureCommand,
		buildCommand,
		archiveTargets: [...config.build.archiveTargets],
		expectedArchives,
		libclang: {
			target: libclangConfig.target,
			archivePath: libclangArchive.path,
			includeRoot: clangIncludeRoot,
			staticLinkArchiveTargets: [...config.build.archiveTargets],
			requiredHeaders
		},
		libclangEvidence: null,
			hostSupportRequirements: {
			target: config.host.compilerTarget,
			tools: {
				cxx: path.join(wasiSdk, 'bin', 'clang++'),
				ar: path.join(wasiSdk, 'bin', 'llvm-ar'),
				ranlib: path.join(wasiSdk, 'bin', 'llvm-ranlib'),
				nm: path.join(wasiSdk, 'bin', 'llvm-nm')
			},
			includeRoots: hostSupportIncludeRoots,
			definitions: [
				...hostSupportConfig.definitions,
				...config.wasi.emulationDefinitions
			],
			archives: hostSupportConfig.archives.map((archive) => ({
				id: archive.id,
				sources: [...archive.sources],
				requiredSymbols: [...archive.requiredSymbols]
			})),
				staticLinkArchiveTargets: [...config.build.archiveTargets],
				compilerRuntime: null
			},
		requiredFinalLinkLibraries: [...config.wasi.finalLinkLibraries],
		upstreamPatchEvidence: null,
		outputs: null,
		errorMessage: null
	};
}

export async function inspectLlvmStaticArchive(filePath) {
	const handle = await open(filePath, 'r');
	try {
		const header = Buffer.alloc(8);
		const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
		if (bytesRead !== 8 || !header.equals(Buffer.from('!<arch>\n'))) {
			throw new Error(`${filePath} is not a static archive`);
		}
		const metadata = await handle.stat();
		const digest = await new Promise((resolve, reject) => {
			const hash = createHash('sha256');
			const stream = createReadStream(filePath);
			stream.on('data', (chunk) => hash.update(chunk));
			stream.on('error', reject);
			stream.on('end', () => resolve(hash.digest('hex')));
		});
		return { path: filePath, bytes: metadata.size, sha256: digest };
	} finally {
		await handle.close();
	}
}

export async function inspectLlvmHeader(filePath) {
	const handle = await open(filePath, 'r');
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.size === 0) {
			throw new Error(`${filePath} is not a non-empty header`);
		}
		const digest = await new Promise((resolve, reject) => {
			const hash = createHash('sha256');
			const stream = createReadStream(filePath);
			stream.on('data', (chunk) => hash.update(chunk));
			stream.on('error', reject);
			stream.on('end', () => resolve(hash.digest('hex')));
		});
		return { path: filePath, bytes: metadata.size, sha256: digest };
	} finally {
		await handle.close();
	}
}

export async function buildTinyGoLlvmWasi(
	options,
	{
		producerRoot = PRODUCER_ROOT,
		run = runCommand,
		inspectArchive = inspectLlvmStaticArchive,
		inspectHeader = inspectLlvmHeader
	} = {}
) {
	const receipt = await createTinyGoLlvmWasiBuildPlan(options, { producerRoot });
	await mkdir(receipt.paths.buildDir, { recursive: true });
	await writeFile(receipt.paths.toolchainPath, receipt.toolchainSource, 'utf8');
	try {
		if (options.checkPatch || options.execute) {
			const revision = await run('git', ['rev-parse', 'HEAD'], {
				cwd: receipt.paths.sourceRoot,
				capture: true
			});
			assert(revision.exitCode === 0, `could not read LLVM source revision: ${revision.stderr}`);
			assert(
				revision.stdout.trim() === receipt.source.commit,
				`LLVM source commit mismatch: expected ${receipt.source.commit}, received ${revision.stdout.trim() || '<missing>'}`
			);
			const fetched = await run(
				'git',
				[
					'fetch',
					'--depth',
					'2',
					receipt.upstreamPatch.repository,
					receipt.upstreamPatch.commit
				],
				{ cwd: receipt.paths.sourceRoot, capture: true }
			);
			assert(
				fetched.exitCode === 0,
				`could not fetch pinned YoWASP LLVM WASI patch ${receipt.upstreamPatch.commit}:\n${fetched.stderr}${fetched.stdout}`
			);
			const upstreamParents = await run(
				'git',
				['show', '-s', '--format=%P', receipt.upstreamPatch.commit],
				{ cwd: receipt.paths.sourceRoot, capture: true }
			);
			assert(
				upstreamParents.exitCode === 0 &&
					upstreamParents.stdout.trim() === receipt.upstreamPatch.parent,
				`YoWASP LLVM WASI patch parent mismatch: expected ${receipt.upstreamPatch.parent}, received ${upstreamParents.stdout.trim() || '<missing>'}`
			);
			const exported = await run(
				'git',
				[
					'diff',
					'--binary',
					receipt.upstreamPatch.parent,
					receipt.upstreamPatch.commit,
					`--output=${receipt.paths.upstreamPatchPath}`,
					'--',
					...receipt.upstreamPatch.expectedPaths
				],
				{ cwd: receipt.paths.sourceRoot, capture: true }
			);
			assert(
				exported.exitCode === 0,
				`could not export pinned YoWASP LLVM WASI patch:\n${exported.stderr}${exported.stdout}`
			);
			const upstreamPatchBytes = await readFile(receipt.paths.upstreamPatchPath);
			const upstreamPatchSource = upstreamPatchBytes.toString('utf8');
			const upstreamPatchedPaths = [
				...upstreamPatchSource.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gmu)
			].map((match) => {
				assert(match[1] === match[2], 'upstream LLVM WASI patch renames a source file');
				return match[1];
			});
			assert(
				JSON.stringify(upstreamPatchedPaths) ===
					JSON.stringify(receipt.upstreamPatch.expectedPaths),
				'YoWASP LLVM WASI host patch path set differs from the source lock'
			);
			receipt.upstreamPatchEvidence = {
				path: receipt.paths.upstreamPatchPath,
				bytes: upstreamPatchBytes.byteLength,
				sha256: createHash('sha256').update(upstreamPatchBytes).digest('hex')
			};
			const upstreamExcludeArgs = receipt.upstreamPatch.excludedPaths.map(
				(excludedPath) => `--exclude=${excludedPath}`
			);
			const reverseCheck = await run(
				'git',
				['apply', '--reverse', '--check', receipt.paths.patchPath],
				{ cwd: receipt.paths.sourceRoot, capture: true }
			);
			const upstreamReverseCheck = await run(
				'git',
				[
					'apply',
					'--reverse',
					'--check',
					...upstreamExcludeArgs,
					receipt.paths.upstreamPatchPath
				],
				{ cwd: receipt.paths.sourceRoot, capture: true }
			);
			if (upstreamReverseCheck.exitCode === 0) {
				receipt.upstreamPatchStatus = 'already-applied';
			} else {
				if (reverseCheck.exitCode === 0) {
					const indexResult = await run(
						'git',
						['rev-parse', '--git-path', 'index'],
						{ cwd: receipt.paths.sourceRoot, capture: true }
					);
					assert(indexResult.exitCode === 0, `could not locate the LLVM Git index:\n${indexResult.stderr}`);
					const sourceIndexPath = path.resolve(
						receipt.paths.sourceRoot,
						indexResult.stdout.trim()
					);
					const temporaryIndexPath = path.join(receipt.paths.buildDir, 'reverse-patch-check.index');
					await writeFile(temporaryIndexPath, await readFile(sourceIndexPath));
					try {
						const capturedPatchedWorktree = await run(
							'git',
							['add', '--', ...new Set([...UPSTREAM_PATCHED_PATHS, ...PATCHED_PATHS])],
							{
								cwd: receipt.paths.sourceRoot,
								capture: true,
								env: { GIT_INDEX_FILE: temporaryIndexPath }
							}
						);
						assert(
							capturedPatchedWorktree.exitCode === 0,
							`could not capture the patched LLVM worktree in a temporary index:\n${capturedPatchedWorktree.stderr}${capturedPatchedWorktree.stdout}`
						);
						const simulatedPortReverse = await run(
							'git',
							['apply', '--cached', '--reverse', receipt.paths.patchPath],
							{
								cwd: receipt.paths.sourceRoot,
								capture: true,
								env: { GIT_INDEX_FILE: temporaryIndexPath }
							}
						);
						assert(
							simulatedPortReverse.exitCode === 0,
							`could not simulate the TinyGo LLVM port reversal:\n${simulatedPortReverse.stderr}${simulatedPortReverse.stdout}`
						);
						const simulatedUpstreamReverse = await run(
							'git',
							[
								'apply',
								'--cached',
								'--reverse',
								'--check',
								...upstreamExcludeArgs,
								receipt.paths.upstreamPatchPath
							],
							{
								cwd: receipt.paths.sourceRoot,
								capture: true,
								env: { GIT_INDEX_FILE: temporaryIndexPath }
							}
						);
						if (simulatedUpstreamReverse.exitCode === 0) {
							receipt.upstreamPatchStatus = 'already-applied';
						}
					} finally {
						await rm(temporaryIndexPath, { force: true });
					}
				}
				if (receipt.upstreamPatchStatus !== 'already-applied') {
					const upstreamApplyCheck = await run(
						'git',
						['apply', '--check', ...upstreamExcludeArgs, receipt.paths.upstreamPatchPath],
						{ cwd: receipt.paths.sourceRoot, capture: true }
					);
					assert(
						upstreamApplyCheck.exitCode === 0,
						`YoWASP LLVM WASI host patch does not apply to ${receipt.source.commit}:\n${upstreamApplyCheck.stderr}${upstreamApplyCheck.stdout}`
					);
					if (options.execute) {
						const upstreamApplied = await run(
							'git',
							['apply', ...upstreamExcludeArgs, receipt.paths.upstreamPatchPath],
							{ cwd: receipt.paths.sourceRoot, capture: true }
						);
						assert(
							upstreamApplied.exitCode === 0,
							`YoWASP LLVM WASI host patch application failed:\n${upstreamApplied.stderr}${upstreamApplied.stdout}`
						);
						receipt.upstreamPatchStatus = 'applied';
					} else receipt.upstreamPatchStatus = 'applicable';
				}
			}
			if (reverseCheck.exitCode === 0) receipt.patchStatus = 'already-applied';
			else {
				let applyCheck;
				if (!options.execute && receipt.upstreamPatchStatus === 'applicable') {
					const indexResult = await run(
						'git',
						['rev-parse', '--git-path', 'index'],
						{ cwd: receipt.paths.sourceRoot, capture: true }
					);
					assert(indexResult.exitCode === 0, `could not locate the LLVM Git index:\n${indexResult.stderr}`);
					const sourceIndexPath = path.resolve(
						receipt.paths.sourceRoot,
						indexResult.stdout.trim()
					);
					const temporaryIndexPath = path.join(receipt.paths.buildDir, 'patch-check.index');
					await writeFile(temporaryIndexPath, await readFile(sourceIndexPath));
					try {
						const simulatedUpstreamApply = await run(
							'git',
							[
								'apply',
								'--cached',
								...upstreamExcludeArgs,
								receipt.paths.upstreamPatchPath
							],
							{
								cwd: receipt.paths.sourceRoot,
								capture: true,
								env: { GIT_INDEX_FILE: temporaryIndexPath }
							}
						);
						assert(
							simulatedUpstreamApply.exitCode === 0,
							`could not simulate the upstream LLVM WASI patch:\n${simulatedUpstreamApply.stderr}${simulatedUpstreamApply.stdout}`
						);
						applyCheck = await run(
							'git',
							['apply', '--cached', '--check', receipt.paths.patchPath],
							{
								cwd: receipt.paths.sourceRoot,
								capture: true,
								env: { GIT_INDEX_FILE: temporaryIndexPath }
							}
						);
					} finally {
						await rm(temporaryIndexPath, { force: true });
					}
				} else {
					applyCheck = await run('git', ['apply', '--check', receipt.paths.patchPath], {
						cwd: receipt.paths.sourceRoot,
						capture: true
					});
				}
				assert(
					applyCheck.exitCode === 0,
					`LLVM WASI patch does not apply to ${receipt.source.commit}:\n${applyCheck.stderr}${applyCheck.stdout}`
				);
				if (options.execute) {
					const applied = await run('git', ['apply', receipt.paths.patchPath], {
						cwd: receipt.paths.sourceRoot,
						capture: true
					});
					assert(
						applied.exitCode === 0,
						`LLVM WASI patch application failed:\n${applied.stderr}${applied.stdout}`
					);
					receipt.patchStatus = 'applied';
				} else receipt.patchStatus = 'applicable';
			}
			if (options.checkPatch) receipt.status = 'patch-checked';
		}
		if (options.execute) {
			await Promise.all([
				access(path.join(receipt.paths.sourceRoot, 'llvm', 'CMakeLists.txt')),
				access(path.join(receipt.paths.wasiSdk, 'bin', 'clang')),
				access(path.join(receipt.paths.wasiSdk, 'bin', 'clang++')),
				access(path.join(receipt.paths.wasiSdk, 'bin', 'llvm-ar')),
				access(path.join(receipt.paths.wasiSdk, 'bin', 'llvm-ranlib')),
				access(path.join(receipt.paths.wasiSdk, 'bin', 'llvm-nm')),
				access(receipt.paths.wasiSysroot),
				access(path.join(receipt.paths.nativeToolDir, 'llvm-tblgen')),
				access(path.join(receipt.paths.nativeToolDir, 'clang-tblgen')),
				access(
					receipt.libclang.requiredHeaders.find(
						(header) => header.name === 'clang-c/Index.h'
					).path
				),
				access(
					receipt.libclang.requiredHeaders.find(
						(header) => header.name === 'llvm-c/Core.h'
					).path
				)
				]);
				const compilerRuntimeResult = await run(
					receipt.hostSupportRequirements.tools.cxx,
					[
						`--target=${receipt.hostSupportRequirements.target}`,
						`--sysroot=${receipt.paths.wasiSysroot}`,
						'--print-libgcc-file-name'
					],
					{ capture: true }
				);
				const compilerRuntimePath = compilerRuntimeResult.stdout.trim();
				assert(
					compilerRuntimeResult.exitCode === 0 && path.isAbsolute(compilerRuntimePath),
					`WASI compiler runtime discovery failed: ${compilerRuntimeResult.stderr}`
				);
				const compilerRuntimeEvidence = await inspectArchive(compilerRuntimePath);
				const compilerRuntimeSymbols = await run(
					receipt.hostSupportRequirements.tools.nm,
					['--defined-only', compilerRuntimePath],
					{ capture: true }
				);
				assert(
					compilerRuntimeSymbols.exitCode === 0,
					`WASI compiler runtime symbol inspection failed: ${compilerRuntimeSymbols.stderr}`
				);
				const compilerRuntimeSymbolTokens = new Set(
					compilerRuntimeSymbols.stdout.split(/\s+/u).filter(Boolean)
				);
				for (const symbol of REQUIRED_COMPILER_RUNTIME_SYMBOLS) {
					assert(
						compilerRuntimeSymbolTokens.has(symbol),
						`WASI compiler runtime is missing required symbol ${symbol}`
					);
				}
				receipt.hostSupportRequirements.compilerRuntime = {
					...compilerRuntimeEvidence,
					requiredSymbols: [...REQUIRED_COMPILER_RUNTIME_SYMBOLS]
				};
				const configured = await run(
				receipt.configureCommand[0],
				receipt.configureCommand.slice(1)
			);
			assert(
				configured.exitCode === 0,
				`LLVM WASI configure failed with ${configured.signal ?? configured.exitCode}`
			);
			if (options.configureOnly) receipt.status = 'configured';
			else {
				const built = await run(receipt.buildCommand[0], receipt.buildCommand.slice(1));
				assert(
					built.exitCode === 0,
					`LLVM WASI archive build failed with ${built.signal ?? built.exitCode}`
				);
				const outputs = [];
				for (const expectedArchive of receipt.expectedArchives) {
					outputs.push({
						target: expectedArchive.target,
						...(await inspectArchive(expectedArchive.path))
					});
				}
				receipt.outputs = outputs;
				const headers = [];
				for (const requiredHeader of receipt.libclang.requiredHeaders) {
					headers.push({
						name: requiredHeader.name,
						...(await inspectHeader(requiredHeader.path))
					});
				}
				receipt.libclangEvidence = {
					archive: outputs.find(
						(output) => output.target === receipt.libclang.target
					),
					headers
				};
				receipt.status = 'passed';
			}
		}
	} catch (error) {
		receipt.status = 'failed';
		receipt.errorMessage = error instanceof Error ? error.message : String(error);
	}
	delete receipt.toolchainSource;
	await mkdir(path.dirname(options.receiptPath), { recursive: true });
	await writeFile(options.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
	if (receipt.status === 'failed') throw new Error(receipt.errorMessage);
	return receipt;
}

function usage() {
	return `Usage: node scripts/build-llvm-wasi.mjs --source-root <llvm-project> --wasi-sdk <wasi-sdk> --native-tool-dir <native LLVM bin> [options]

Creates a source-pinned wasm32-wasip1 plan for the static LLVM archives linked by go-llvm.
The default is a dry run and never configures or builds LLVM.

Options:
  --build-dir <dir>       Cross-build directory
  --receipt <file>        Plan/build receipt path
  --jobs <n>              Capped build parallelism (default: up to 4)
  --check-patch           Verify commit and patch applicability without modifying source
  --execute               Apply the patch and run CMake/Ninja
  --configure-only        With --execute, stop after CMake configuration`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		const options = parseBuildLlvmWasiArgs(process.argv.slice(2));
		if (options.help) console.log(usage());
		else {
			const receipt = await buildTinyGoLlvmWasi(options);
			console.log(`${receipt.status}: ${options.receiptPath}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
