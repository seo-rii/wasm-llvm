#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, constants as fsConstants } from 'node:fs';
import {
	access,
	chmod,
	cp,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	loadTinyGoProducerContract,
	sha256,
	verifyTinyGoSourceReceipt
} from './source-contract.mjs';
import { verifyTinyGoArtifactPayloads } from './verify-artifacts.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const PRODUCER_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const BUILD_RECEIPT_FORMAT = 'wasm-llvm-tinygo-browser-compiler-build-v1';
const LLVM_RECEIPT_FORMAT = 'wasm-llvm-tinygo-llvm-wasi-static-v1';
const ADAPTER_PATCH_PATH = 'patches/tinygo-wasi-adapter.patch';
const GO_LLVM_PATCH_PATH = 'patches/go-llvm-wasi-cgo-alias.patch';
const GO_TOOLCHAIN_PATCH_PATH = 'patches/go-toolchain-wasip1-exec.patch';
const ADAPTER_ENTRYPOINT = 'cmd/tinygo-browser-adapter/main.go';
const GO_LLVM_ALIAS_PATH = 'tinygo_cgo_unsigned.go';
const GO_TOOLCHAIN_EXEC_PATH = 'src/os/exec/exec.go';
const WASI_LIBC_MALLOC_MEMBER = 'dlmalloc.c.obj';
const COMPILER_HOST_STACK_SIZE = 8 * 1024 * 1024;
const COMPILER_INTERP_TIMEOUT = '10m';
const COMPILER_HOST_FEATURES =
	'+bulk-memory,+bulk-memory-opt,+call-indirect-overlong,+mutable-globals,+nontrapping-fptoint,+sign-ext,-multivalue,-reference-types';
const ROOT_ARCHIVE_PATHS = [
	'src',
	'go.env',
	'targets',
	'go.mod',
	'go.sum',
	'lib/clang',
	'lib/wasi-libc/include',
	'lib/wasi-libc/include/c++/v1',
	'runtime'
];
const RUNTIME_CLOSURE_FORMAT = 'wasm-llvm-tinygo-runtime-closure-v2';
const RUNTIME_PROFILE = Object.freeze({
	id: 'wasip1-asyncify-precise-o1',
	target: 'wasip1',
	opt: '1',
	gc: 'precise',
	panicStrategy: 'print',
	scheduler: 'asyncify',
	debug: false,
	parallelism: 1
});
const RUNTIME_EXTRA_INPUTS = [
	{
		source: 'src/runtime/asm_tinygowasm.S',
		format: 'wasm-object',
		outputName: 'extra-0.o'
	},
	{
		source: 'src/runtime/gc_boehm.c',
		format: 'llvm-bitcode',
		outputName: 'extra-1.bc'
	},
	{
		source: 'src/internal/task/task_asyncify_wasm.S',
		format: 'wasm-object',
		outputName: 'extra-2.o'
	}
];
const RUNTIME_EXTRA_SOURCES = RUNTIME_EXTRA_INPUTS.map((input) => input.source);
const REQUIRED_LLVM_HEADERS = [
	'clang-c/Index.h',
	'llvm-c/Core.h',
	'llvm/Config/llvm-config.h'
];
const NATIVE_ROOT_IDENTITY_PATHS = [
	'go.mod',
	'main.go',
	'cgo/libclang.go',
	'builder/tools-builtin.go'
];
const CLANG_RESOURCE_IDENTITY_PATHS = [
	'include/stddef.h',
	'include/stdint.h'
];
const HOST_SUPPORT_SOURCES = {
	tinygo: ['builder/cc1as.cpp', 'builder/clang.cpp', 'builder/lld.cpp'],
	goLlvm: ['IRBindings.cpp', 'SupportBindings.cpp', 'backports.cpp']
};
const TINYGO_HOST_SUPPORT_IDENTITY_PATHS = [
	...HOST_SUPPORT_SOURCES.tinygo,
	'builder/cc1as.h',
	'builder/tools-builtin.go'
];
const HOST_SUPPORT_OBJECTS = {
	tinygo: ['cc1as.o', 'clang.o', 'lld.o'],
	goLlvm: ['IRBindings.o', 'SupportBindings.o', 'backports.o']
};
const HOST_SUPPORT_SYMBOLS = {
	tinygo: ['tinygo_clang_driver', 'tinygo_link', 'tinygo_validate_wasm_object'],
	goLlvm: [
		'LLVMConstantAsMetadata',
		'LLVMLoadLibraryPermanently2',
		'LLVMGoWriteThinLTOBitcodeToMemoryBuffer'
	]
};
const HOST_SUPPORT_ARCHIVE_IDS = {
	tinygo: 'tinygo-builder-cxx',
	goLlvm: 'go-llvm-cxx'
};
const REQUIRED_HOST_SUPPORT_DEFINITIONS = [
	'CINDEX_NO_EXPORTS',
	'_WASI_EMULATED_GETPID',
	'_WASI_EMULATED_MMAN',
	'_WASI_EMULATED_PROCESS_CLOCKS',
	'_WASI_EMULATED_SIGNAL'
];
const REQUIRED_COMPILER_RUNTIME_SYMBOLS = ['__multi3', '__udivti3'];
const COMPILER_HOST_OBJECTS = [
	{
		id: 'tinygo-runtime-stack',
		source: 'src/runtime/asm_tinygowasm.S',
		language: 'assembler-with-cpp',
		flags: []
	},
	{
		id: 'tinygo-libclang-abi',
		source: 'cgo/libclang_stubs.c',
		language: 'c',
		flags: ['-std=c11']
	}
];
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const EMBED_OBJECT_PATTERN = /^embed-([0-9a-f]{32})-[0-9]+\.o$/u;

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function assertPathOutsideRoot(candidatePath, rootPath, label) {
	assert(path.isAbsolute(candidatePath), `${label} must be absolute`);
	const relative = path.relative(rootPath, candidatePath);
	assert(
		relative === '..' ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative),
		`${label} must be outside ${rootPath}`
	);
}

export function parseTinyGoRuntimeLinkTrace(trace) {
	const linkerLines = String(trace)
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => {
			if (!line) return false;
			const executable = line.split(/\s+/u, 1)[0];
			return /^wasm-ld(?:-[0-9]+)?(?:\.exe)?$/iu.test(path.basename(executable));
		});
	assert(linkerLines.length === 1, 'TinyGo runtime probe must emit exactly one wasm-ld command');
	assert(
		!/["']/u.test(linkerLines[0]),
		'TinyGo runtime probe paths containing shell quotes are unsupported'
	);
	const arguments_ = linkerLines[0].split(/\s+/u).slice(1);
	const compilerRT = arguments_.find((argument) =>
		/(?:^|[/\\])compiler-rt-[^/\\]+[/\\]lib\.a$/u.test(argument)
	);
	const wasiLibc = arguments_.find((argument) =>
		/(?:^|[/\\])wasi-libc-[^/\\]+[/\\]lib\.a$/u.test(argument)
	);
	assert(compilerRT && path.isAbsolute(compilerRT), 'runtime probe did not emit compiler-rt');
	assert(wasiLibc && path.isAbsolute(wasiLibc), 'runtime probe did not emit wasi-libc');
	const compilerRTIndex = arguments_.indexOf(compilerRT);
	const wasiLibcIndex = arguments_.indexOf(wasiLibc);
	assert(
		compilerRTIndex >= 0 && wasiLibcIndex > compilerRTIndex,
		'runtime probe emitted an invalid runtime archive order'
	);
	const extraArtifacts = arguments_
		.slice(compilerRTIndex + 1, wasiLibcIndex)
		.filter((argument) => argument.endsWith('.bc'));
	assert(
		extraArtifacts.length === RUNTIME_EXTRA_SOURCES.length,
		`runtime probe must emit ${RUNTIME_EXTRA_SOURCES.length} extra bitcode files`
	);
	assert(
		extraArtifacts.every((artifact) => path.isAbsolute(artifact)),
		'runtime probe emitted a non-absolute extra bitcode path'
	);
	return {
		compilerRT,
		wasiLibc,
		extraFiles: Object.fromEntries(
			RUNTIME_EXTRA_SOURCES.map((source, index) => [source, extraArtifacts[index]])
		)
	};
}

function runCommand(command, args, { cwd, env, capture = false } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env,
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

export function parseBuildBrowserCompilerArgs(argv) {
	const options = {
		sourceRoot: null,
		sourceReceiptPath: null,
		llvmReceiptPath: null,
		nativeTinyGo: null,
		nativeTinyGoRoot: null,
		clangResourceDir: null,
		wasmOpt: null,
		nativeWasmLd: null,
		goToolchainArchive: null,
		goLlvmSourceRoot: null,
		artifactDir: null,
		buildDir: null,
		receiptPath: null,
		execute: false
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--') continue;
		if (argument === '--help' || argument === '-h') return { help: true };
		if (argument === '--execute') {
			options.execute = true;
			continue;
		}
		const key = {
			'--source-root': 'sourceRoot',
			'--source-receipt': 'sourceReceiptPath',
			'--llvm-receipt': 'llvmReceiptPath',
			'--tinygo': 'nativeTinyGo',
			'--native-tinygo-root': 'nativeTinyGoRoot',
			'--clang-resource-dir': 'clangResourceDir',
			'--wasm-opt': 'wasmOpt',
			'--native-wasm-ld': 'nativeWasmLd',
			'--go-toolchain-archive': 'goToolchainArchive',
			'--go-llvm-source-root': 'goLlvmSourceRoot',
			'--artifact-dir': 'artifactDir',
			'--build-dir': 'buildDir',
			'--receipt': 'receiptPath'
		}[argument];
		if (!key) throw new Error(`Unknown option: ${argument}`);
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
		options[key] = path.resolve(value);
		index += 1;
	}
	for (const [key, flag] of [
		['sourceRoot', '--source-root'],
		['sourceReceiptPath', '--source-receipt'],
		['llvmReceiptPath', '--llvm-receipt'],
		['nativeTinyGo', '--tinygo'],
		['nativeWasmLd', '--native-wasm-ld'],
		['goToolchainArchive', '--go-toolchain-archive'],
		['goLlvmSourceRoot', '--go-llvm-source-root'],
		['artifactDir', '--artifact-dir']
	]) {
		if (!options[key]) throw new Error(`${flag} is required`);
	}
	assert(
		!/^go(?:\.exe)?$/iu.test(path.basename(options.nativeTinyGo)),
		'--tinygo must name a native TinyGo compiler, not the standard Go compiler'
	);
	assert(
		/^wasm-ld(?:-[0-9]+)?(?:\.exe)?$/iu.test(path.basename(options.nativeWasmLd)),
		'--native-wasm-ld must name an external wasm-ld executable'
	);
	options.buildDir ??= path.join(path.dirname(options.artifactDir), 'tinygo-browser-build');
	options.receiptPath ??= path.join(options.buildDir, 'tinygo-browser-build.json');
	return options;
}

export function validateLlvmWasiReceipt(receipt, { contract }) {
	assert(receipt?.format === LLVM_RECEIPT_FORMAT, 'unexpected LLVM WASI receipt format');
	assert(receipt?.status === 'passed', 'LLVM WASI receipt must have status passed');
	assert(
		receipt?.inputs?.sourcesLockSha256 === contract.inputs.sourcesLockSha256,
		'LLVM WASI receipt is not bound to the current TinyGo sources lock'
	);
	const llvmPatch = contract.lock.patches.find(
		(entry) => entry.path === 'patches/llvm-wasi-c-api-config.patch'
	);
	assert(llvmPatch, 'LLVM WASI platform patch is not registered in the TinyGo source lock');
	assert(
		receipt?.inputs?.patchSha256 === llvmPatch.sha256,
		'LLVM WASI receipt is not bound to the registered platform patch'
	);
	assert(
		receipt?.inputs?.upstreamPatchCommit === contract.lock.wasiHostPatch.commit &&
			receipt?.inputs?.upstreamPatchParent === contract.lock.wasiHostPatch.parent,
		'LLVM WASI receipt is not bound to the pinned YoWASP host patch'
	);
	assert(
		SHA256_PATTERN.test(receipt?.inputs?.configSha256 ?? '') &&
			SHA256_PATTERN.test(receipt?.inputs?.producerScriptSha256 ?? ''),
		'LLVM WASI receipt is missing producer/configuration provenance'
	);
	assert(
		receipt?.upstreamPatchStatus === 'applied' ||
			receipt?.upstreamPatchStatus === 'already-applied',
		'passed LLVM WASI receipt must record the pinned YoWASP host patch as applied'
	);
	assert(
		path.isAbsolute(receipt?.upstreamPatchEvidence?.path ?? '') &&
			Number.isSafeInteger(receipt?.upstreamPatchEvidence?.bytes) &&
			receipt.upstreamPatchEvidence.bytes > 0 &&
			SHA256_PATTERN.test(receipt?.upstreamPatchEvidence?.sha256 ?? ''),
		'passed LLVM WASI receipt is missing YoWASP host patch evidence'
	);
	assert(
		receipt?.patchStatus === 'applied' ||
			receipt?.patchStatus === 'already-applied',
		'passed LLVM WASI receipt must record its registered patch as applied'
	);
	assert(
		receipt?.source?.commit === contract.lock.llvm.commit,
		'LLVM WASI receipt source commit differs from the TinyGo source lock'
	);
	assert(
		receipt?.host?.compilerTarget === contract.manifest.target,
		'LLVM WASI receipt compiler target must be wasm32-wasip1'
	);
	assert(
		Array.isArray(receipt?.projects) &&
			receipt.projects.includes('clang') &&
			receipt.projects.includes('lld'),
		'LLVM WASI receipt must include the real Clang/libclang and LLD projects'
	);
	assert(
		Array.isArray(receipt?.outputs) && receipt.outputs.length > 0,
		'LLVM WASI receipt must contain static archive evidence'
	);
	const outputPaths = new Set();
	const outputTargets = new Set();
	for (const [index, output] of receipt.outputs.entries()) {
		assert(path.isAbsolute(output?.path ?? ''), `LLVM output ${index} path must be absolute`);
		assert(!outputPaths.has(output.path), `duplicate LLVM output path ${output.path}`);
		outputPaths.add(output.path);
		assert(
			/^(?:libclang|clang[A-Za-z0-9]+|lld[A-Za-z0-9]+|LLVM[A-Za-z0-9]+)$/u.test(
				output?.target ?? ''
			),
			`LLVM output ${index} target is invalid`
		);
		assert(!outputTargets.has(output.target), `duplicate LLVM output target ${output.target}`);
		outputTargets.add(output.target);
		assert(output.path.endsWith('.a'), `LLVM output ${output.path} must be a static archive`);
		assert(Number.isSafeInteger(output.bytes) && output.bytes > 8, `${output.path} size is invalid`);
		assert(SHA256_PATTERN.test(output.sha256 ?? ''), `${output.path} SHA-256 is invalid`);
	}

	const libclang = receipt?.libclang;
	const libclangEvidence = receipt?.libclangEvidence;
	assert(libclang?.target === 'libclang', 'LLVM WASI receipt must target static libclang');
	assert(path.isAbsolute(libclang?.archivePath ?? ''), 'libclang archive path must be absolute');
	assert(path.isAbsolute(libclang?.includeRoot ?? ''), 'libclang include root must be absolute');
	assert(
		Array.isArray(libclang?.staticLinkArchiveTargets) &&
			libclang.staticLinkArchiveTargets.includes('libclang'),
		'libclang static link closure is missing'
	);
	assert(
		new Set(libclang.staticLinkArchiveTargets).size === libclang.staticLinkArchiveTargets.length,
		'libclang static link closure contains duplicate targets'
	);
	assert(libclangEvidence?.archive, 'LLVM WASI receipt is missing libclang archive evidence');
	assert(
		libclangEvidence.archive.path === libclang.archivePath,
		'libclang archive evidence path differs from the build plan'
	);
	assert(
		outputPaths.has(libclangEvidence.archive.path),
		'libclang archive is not included in LLVM output evidence'
	);
	const recordedLibclangOutput = receipt.outputs.find(
		(output) => output.path === libclangEvidence.archive.path
	);
	assert(
		recordedLibclangOutput.bytes === libclangEvidence.archive.bytes &&
			recordedLibclangOutput.sha256 === libclangEvidence.archive.sha256,
		'libclang archive evidence differs from LLVM output evidence'
	);

	assert(
		JSON.stringify((libclang.requiredHeaders ?? []).map((header) => header.name)) ===
			JSON.stringify(REQUIRED_LLVM_HEADERS),
		'libclang plan must bind the exact Clang C API, LLVM C API, and generated config headers'
	);
	assert(
		JSON.stringify((libclangEvidence.headers ?? []).map((header) => header.name)) ===
			JSON.stringify(REQUIRED_LLVM_HEADERS),
		'libclang evidence must bind the exact required header set'
	);
	const plannedHeaders = new Map(
		(libclang.requiredHeaders ?? []).map((header) => [header.name, header.path])
	);
	const evidenceHeaders = new Map(
		(libclangEvidence.headers ?? []).map((header) => [header.name, header])
	);
	for (const requiredHeader of REQUIRED_LLVM_HEADERS) {
		const plannedPath = plannedHeaders.get(requiredHeader);
		const evidence = evidenceHeaders.get(requiredHeader);
		assert(path.isAbsolute(plannedPath ?? ''), `libclang plan is missing ${requiredHeader}`);
		assert(evidence?.path === plannedPath, `libclang evidence is missing ${requiredHeader}`);
		assert(
			Number.isSafeInteger(evidence.bytes) && evidence.bytes > 0,
			`${requiredHeader} size is invalid`
		);
		assert(SHA256_PATTERN.test(evidence.sha256 ?? ''), `${requiredHeader} SHA-256 is invalid`);
		const normalizedPath = evidence.path.replaceAll('\\', '/');
		assert(
			normalizedPath.endsWith(`/${requiredHeader}`),
			`${requiredHeader} evidence has an unexpected path`
		);
	}

	const outputByTarget = new Map();
	for (const target of libclang.staticLinkArchiveTargets) {
		const output = receipt.outputs.find((candidate) => {
			if (candidate.target === target) return true;
			if (target === libclang.target && candidate.path === libclang.archivePath) return true;
			const basename = path.basename(candidate.path);
			return basename === `${target}.a` || basename === `lib${target}.a`;
		});
		assert(output, `LLVM WASI receipt is missing static archive target ${target}`);
		outputByTarget.set(target, output);
	}
	for (const requiredTarget of ['LLVMCore', 'LLVMSupport', 'LLVMWebAssemblyCodeGen']) {
		assert(
			outputByTarget.has(requiredTarget),
			`LLVM WASI receipt is missing go-llvm archive ${requiredTarget}`
		);
	}
	assert(
		path.isAbsolute(receipt?.paths?.wasiSysroot ?? ''),
		'LLVM WASI receipt must identify the WASI sysroot'
	);
	assert(
		path.isAbsolute(receipt?.paths?.sourceRoot ?? ''),
		'LLVM WASI receipt must identify the pinned LLVM source root'
	);
	assert(
		Array.isArray(receipt?.requiredFinalLinkLibraries) &&
			receipt.requiredFinalLinkLibraries.includes('dl') &&
			receipt.requiredFinalLinkLibraries.includes('c++') &&
			receipt.requiredFinalLinkLibraries.includes('c++abi') &&
			receipt.requiredFinalLinkLibraries.every((library) =>
				/^[A-Za-z0-9+_.-]+$/u.test(library)
			) &&
			new Set(receipt.requiredFinalLinkLibraries).size ===
				receipt.requiredFinalLinkLibraries.length,
		'LLVM WASI receipt must include libdl, libc++, and libc++abi final link libraries'
	);
	const hostSupport = receipt?.hostSupportRequirements;
	assert(
		hostSupport?.target === contract.manifest.target,
		'TinyGo C++ host support must target wasm32-wasip1'
	);
	for (const [tool, expectedBasename] of Object.entries({
		cxx: 'clang++',
		ar: 'llvm-ar',
		ranlib: 'llvm-ranlib',
		nm: 'llvm-nm'
	})) {
		const toolPath = hostSupport?.tools?.[tool];
		assert(path.isAbsolute(toolPath ?? ''), `host-support ${tool} path must be absolute`);
		assert(
			path.basename(toolPath).replace(/\.exe$/iu, '') === expectedBasename,
			`host-support ${tool} must use ${expectedBasename}`
		);
	}
	assert(
		Array.isArray(hostSupport?.includeRoots) &&
			hostSupport.includeRoots.length === 6 &&
			hostSupport.includeRoots.every((root) => path.isAbsolute(root)) &&
			new Set(hostSupport.includeRoots).size === hostSupport.includeRoots.length,
		'host-support include roots must cover unique LLVM, Clang, and LLD source/build trees'
	);
	assert(
		JSON.stringify(hostSupport?.definitions) ===
			JSON.stringify(REQUIRED_HOST_SUPPORT_DEFINITIONS),
		'host-support preprocessor definitions differ from the WASI Clang/LLVM contract'
	);
	const expectedHostArchives = Object.keys(HOST_SUPPORT_ARCHIVE_IDS).map((owner) => ({
		id: HOST_SUPPORT_ARCHIVE_IDS[owner],
		sources: HOST_SUPPORT_SOURCES[owner],
		requiredSymbols: HOST_SUPPORT_SYMBOLS[owner]
	}));
	assert(
		JSON.stringify(hostSupport?.archives) === JSON.stringify(expectedHostArchives),
		'host-support archives do not bind the six upstream C++ translation units'
	);
	assert(
		JSON.stringify(hostSupport?.staticLinkArchiveTargets) ===
			JSON.stringify(libclang.staticLinkArchiveTargets),
		'host-support Clang, LLD, and LLVM archive closure differs from libclang linkage'
	);
	assert(
		path.isAbsolute(hostSupport?.compilerRuntime?.path ?? '') &&
			Number.isSafeInteger(hostSupport?.compilerRuntime?.bytes) &&
			hostSupport.compilerRuntime.bytes > 8 &&
			SHA256_PATTERN.test(hostSupport?.compilerRuntime?.sha256 ?? ''),
		'host-support compiler runtime evidence is missing'
	);
	assert(
		JSON.stringify(hostSupport.compilerRuntime.requiredSymbols) ===
			JSON.stringify(REQUIRED_COMPILER_RUNTIME_SYMBOLS),
		'host-support compiler runtime must provide the required 128-bit builtins'
	);
	return {
		outputByTarget,
		requiredHeaders: REQUIRED_LLVM_HEADERS.map((name) => evidenceHeaders.get(name)),
		hostSupport
	};
}

export async function inspectBuildFile(
	filePath,
	{ staticArchive = false, wasmObject = false, llvmBitcode = false } = {}
) {
	assert(
		[staticArchive, wasmObject, llvmBitcode].filter(Boolean).length <= 1,
		`${filePath} cannot have multiple binary formats`
	);
	const handle = await open(filePath, 'r');
	try {
		const metadata = await handle.stat();
		assert(metadata.isFile() && metadata.size > 0, `${filePath} is not a non-empty file`);
		if (staticArchive || wasmObject || llvmBitcode) {
			const header = Buffer.alloc(8);
			const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
			if (staticArchive) {
				assert(
					bytesRead === header.byteLength &&
						header.equals(Buffer.from('!<arch>\n')),
					`${filePath} is not a static archive`
				);
			} else if (wasmObject) {
				assert(
					bytesRead === header.byteLength &&
						header.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d])) &&
						header.subarray(4).equals(Buffer.from([0x01, 0x00, 0x00, 0x00])),
					`${filePath} is not a WebAssembly relocatable object`
				);
			} else {
				assert(
					bytesRead >= 4 &&
						header.subarray(0, 4).equals(Buffer.from([0x42, 0x43, 0xc0, 0xde])),
					`${filePath} is not LLVM bitcode`
				);
			}
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

async function inspectDirectoryTree(directoryPath) {
	const files = [];
	async function visit(currentPath, relativeRoot) {
		const entries = await readdir(currentPath, { withFileTypes: true });
		entries.sort((left, right) =>
			Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))
		);
		for (const entry of entries) {
			const absolutePath = path.join(currentPath, entry.name);
			const relativePath = path.posix.join(relativeRoot, entry.name);
			if (entry.isDirectory()) {
				await visit(absolutePath, relativePath);
				continue;
			}
			assert(entry.isFile(), `${absolutePath} is not a regular file`);
			const evidence = await inspectBuildFile(absolutePath);
			files.push({
				path: relativePath,
				bytes: evidence.bytes,
				sha256: evidence.sha256
			});
		}
	}
	await visit(directoryPath, '');
	assert(files.length > 0, `${directoryPath} is empty`);
	return {
		path: directoryPath,
		files: files.length,
		bytes: files.reduce((total, file) => total + file.bytes, 0),
		sha256: sha256(Buffer.from(JSON.stringify(files)))
	};
}

export async function createBrowserCompilerBuildPlan(
	options,
	{
		producerRoot = PRODUCER_ROOT,
		contract: suppliedContract = null,
		verifySource = verifyTinyGoSourceReceipt
	} = {}
) {
	const contract = suppliedContract ?? (await loadTinyGoProducerContract(producerRoot));
	const sourceReceiptBytes = await readFile(options.sourceReceiptPath);
	const sourceReceipt = await verifySource({
		sourceDir: options.sourceRoot,
		receiptPath: options.sourceReceiptPath,
		producerRoot
	});
	assert(path.isAbsolute(options.sourceRoot), '--source-root must be absolute');
	assert(
		path.isAbsolute(options.goLlvmSourceRoot),
		'--go-llvm-source-root must be absolute'
	);
	assert(
		path.isAbsolute(options.goToolchainArchive),
		'--go-toolchain-archive must be absolute'
	);
	const patchEntries = new Map(
		contract.lock.patches.map((entry) => [entry.path, entry])
	);
	const patchEntry = patchEntries.get(ADAPTER_PATCH_PATH);
	const goLlvmPatchEntry = patchEntries.get(GO_LLVM_PATCH_PATH);
	const goToolchainPatchEntry = patchEntries.get(GO_TOOLCHAIN_PATCH_PATH);
	for (const [entry, patchPath] of [
		[patchEntry, ADAPTER_PATCH_PATH],
		[goLlvmPatchEntry, GO_LLVM_PATCH_PATH],
		[goToolchainPatchEntry, GO_TOOLCHAIN_PATCH_PATH]
	]) {
		assert(entry, `${patchPath} is not registered in the TinyGo sources lock`);
	}
	const scriptPath = path.join(producerRoot, 'scripts', 'build-browser-compiler.mjs');
	const patchPath = path.join(producerRoot, patchEntry.path);
	const goLlvmPatchPath = path.join(producerRoot, goLlvmPatchEntry.path);
	const goToolchainPatchPath = path.join(producerRoot, goToolchainPatchEntry.path);
	const [
		scriptBytes,
		patchBytes,
		goLlvmPatchBytes,
		goToolchainPatchBytes,
		llvmReceiptBytes
	] = await Promise.all([
		readFile(scriptPath),
		readFile(patchPath),
		readFile(goLlvmPatchPath),
		readFile(goToolchainPatchPath),
		readFile(options.llvmReceiptPath)
	]);
	assert(
		sha256(patchBytes) === patchEntry.sha256,
		`${ADAPTER_PATCH_PATH} checksum differs from the TinyGo sources lock`
	);
	assert(
		sha256(goLlvmPatchBytes) === goLlvmPatchEntry.sha256,
		`${GO_LLVM_PATCH_PATH} checksum differs from the TinyGo sources lock`
	);
	assert(
		sha256(goToolchainPatchBytes) === goToolchainPatchEntry.sha256,
		`${GO_TOOLCHAIN_PATCH_PATH} checksum differs from the TinyGo sources lock`
	);
	const patchSource = patchBytes.toString('utf8');
	const patchedPaths = [...patchSource.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gmu)].map(
		(match) => {
			assert(match[1] === match[2], `${ADAPTER_PATCH_PATH} renames ${match[1]}`);
			return match[1];
		}
	);
	assert(
		patchedPaths.includes(ADAPTER_ENTRYPOINT),
		`${ADAPTER_PATCH_PATH} does not add the upstream compiler adapter`
	);
	const allowedCgoAdapterPaths = new Set([
		'cgo/libclang.go',
		'cgo/libclang_stubs.c',
		'cgo/unsigned_wasip1.go'
	]);
	assert(
		!patchedPaths.some(
			(entry) =>
				/^(?:compiler|interp|transform)\//u.test(entry) ||
				(entry.startsWith('cgo/') && !allowedCgoAdapterPaths.has(entry))
		),
		`${ADAPTER_PATCH_PATH} changes compiler semantics outside the registered wasm32 cgo ABI adapter`
	);

	for (const [candidatePath, label] of [
		[options.buildDir, '--build-dir'],
		[options.artifactDir, '--artifact-dir'],
		[options.receiptPath, '--receipt']
	]) {
		assertPathOutsideRoot(candidatePath, options.sourceRoot, label);
		assertPathOutsideRoot(candidatePath, options.goLlvmSourceRoot, label);
	}

	assert(
		Array.isArray(contract.lock.goLlvm.hostSupportSources) &&
			contract.lock.goLlvm.hostSupportSources.length > 0,
		'go-llvm host-support sources are not pinned in the TinyGo sources lock'
	);
	const goLlvmSourceEvidence = [];
	for (const source of contract.lock.goLlvm.hostSupportSources) {
		const absolutePath = path.join(options.goLlvmSourceRoot, source.path);
		const bytes = await readFile(absolutePath);
		assert(
			sha256(bytes) === source.sha256,
			`${source.path} differs from locked go-llvm ${contract.lock.goLlvm.version}`
		);
		goLlvmSourceEvidence.push({
			path: source.path,
			absolutePath,
			bytes: bytes.length,
			sha256: source.sha256
		});
	}

	const llvmReceipt = JSON.parse(llvmReceiptBytes);
	const llvmInputs = validateLlvmWasiReceipt(llvmReceipt, { contract });
	const includeRoots = [];
	for (const header of llvmInputs.requiredHeaders) {
		const normalizedHeaderPath = header.path.replaceAll('\\', '/');
		const root = normalizedHeaderPath.slice(0, -header.name.length - 1);
		if (!includeRoots.includes(root)) includeRoots.push(root);
	}
	if (!includeRoots.includes(llvmReceipt.libclang.includeRoot)) {
		includeRoots.unshift(llvmReceipt.libclang.includeRoot);
	}
	const staticArchives = llvmReceipt.libclang.staticLinkArchiveTargets.map(
		(target) => llvmInputs.outputByTarget.get(target).path
	);
	const wasiSysroot = llvmReceipt.paths.wasiSysroot;
	const wasiLibraryDir = path.join(
		wasiSysroot,
		'lib',
		contract.manifest.target
	);
	const wasiCxxLibraryDir = path.join(wasiLibraryDir, 'noeh');
	const wasiLibraries = llvmReceipt.requiredFinalLinkLibraries.map((library) => ({
		name: library,
		path: path.join(
			library === 'c++' || library === 'c++abi'
				? wasiCxxLibraryDir
				: wasiLibraryDir,
			`lib${library}.a`
		),
		bytes: null,
		sha256: null
	}));
	const patchedSourceRoot = path.join(options.buildDir, 'tinygo-v0.40.1-wasi');
	const compilerRtBuiltinsSourcePath = path.join(
		llvmReceipt.paths.sourceRoot,
		'compiler-rt',
		'lib',
		'builtins'
	);
	const compilerRtBuiltinsArchivePath = path.join(
		patchedSourceRoot,
		'lib',
		'compiler-rt-builtins'
	);
	const compilerRtBuiltinsSource = await inspectDirectoryTree(
		compilerRtBuiltinsSourcePath
	);
	const patchedGoLlvmRoot = path.join(options.buildDir, 'go-llvm-wasi');
	const goToolchainExtractDir = path.join(options.buildDir, 'go-toolchain');
	const goToolchainRoot = path.join(
		goToolchainExtractDir,
		contract.lock.goToolchain.archiveRoot
	);
	const goWorkPath = path.join(options.buildDir, 'go.work');
	const targetConfigPath = path.join(options.buildDir, 'tinygo-browser-host.json');
	const compilerBitcodePath = path.join(options.buildDir, 'tinygo-compiler.bc');
	const compilerPath = path.join(options.artifactDir, 'tinygo-compiler.wasm');
	const tinygoRootPath = path.join(options.artifactDir, 'tinygoroot.tar.gz');
	const hostSupportDir = path.join(options.buildDir, 'host-support');
	const compilerHostObjectDir = path.join(hostSupportDir, 'compiler-objects');
	const hostLinkInputDir = path.join(options.buildDir, 'host-link-inputs');
	const browserRootOverlayDir = path.join(options.buildDir, 'browser-root-overlay');
	const browserWasiLibcIncludeDir = path.join(
		browserRootOverlayDir,
		'lib',
		'wasi-libc',
		'include'
	);
	const browserCxxIncludeDir = path.join(browserWasiLibcIncludeDir, 'c++', 'v1');
	const runtimeClosureDir = path.join(browserRootOverlayDir, 'runtime');
	const runtimeProfileDir = path.join(runtimeClosureDir, RUNTIME_PROFILE.id);
	const runtimeProbePath = path.join(options.buildDir, 'runtime-closure-probe.wasm');
	const wasiLibcSourcePath = path.join(wasiLibraryDir, 'libc.a');
	const wasiCxxIncludeDir = path.join(wasiSysroot, 'include', 'c++', 'v1');
	const filteredWasiLibcPath = path.join(hostSupportDir, 'libc-no-dlmalloc.a');
	const lockedTinyGoSources = new Map(
		contract.lock.compilerIdentity.requiredSources.map((source) => [source.path, source])
	);
	const tinyGoSourceEvidence = [];
	for (const relativePath of TINYGO_HOST_SUPPORT_IDENTITY_PATHS) {
		const lockedSource = lockedTinyGoSources.get(relativePath);
		assert(lockedSource, `${relativePath} is not pinned as TinyGo host-support source`);
		const absolutePath = path.join(options.sourceRoot, relativePath);
		const bytes = await readFile(absolutePath);
		assert(
			sha256(bytes) === lockedSource.sha256,
			`${relativePath} differs from locked TinyGo ${contract.lock.tinygo.version}`
		);
		tinyGoSourceEvidence.push({
			path: relativePath,
			absolutePath,
			bytes: bytes.length,
			sha256: lockedSource.sha256
		});
	}
	const hostSupportCompileFlags = [
		`--target=${contract.manifest.target}`,
		`--sysroot=${wasiSysroot}`,
		'-stdlib=libc++',
		'-std=c++17',
		'-fno-exceptions',
		'-fno-rtti',
		'-Oz',
		'-ffunction-sections',
		'-fdata-sections',
		'-frandom-seed=wasm-llvm-tinygo-host-support-v1',
		'-D_GNU_SOURCE',
		'-D__STDC_CONSTANT_MACROS',
		'-D__STDC_FORMAT_MACROS',
		'-D__STDC_LIMIT_MACROS',
		'-DCLANG_BUILD_STATIC',
		...llvmInputs.hostSupport.definitions.map((definition) => `-D${definition}`),
		...llvmInputs.hostSupport.includeRoots.map((root) => `-I${root}`),
		`-I${path.join(patchedSourceRoot, 'builder')}`,
		`-I${patchedGoLlvmRoot}`,
		`-ffile-prefix-map=${patchedSourceRoot}=/tinygo`,
		`-ffile-prefix-map=${patchedGoLlvmRoot}=/go-llvm`,
		`-fdebug-prefix-map=${patchedSourceRoot}=/tinygo`,
		`-fdebug-prefix-map=${patchedGoLlvmRoot}=/go-llvm`
	];
	const hostSupportArchives = llvmInputs.hostSupport.archives.map((archive) => {
		const owner = archive.id === HOST_SUPPORT_ARCHIVE_IDS.tinygo ? 'tinygo' : 'goLlvm';
		const sourceRoot = owner === 'tinygo' ? patchedSourceRoot : patchedGoLlvmRoot;
		const ownerDir = path.join(hostSupportDir, owner);
		const objects = archive.sources.map((source, index) => ({
			source: path.join(sourceRoot, source),
			path: path.join(ownerDir, HOST_SUPPORT_OBJECTS[owner][index])
		}));
		const archivePath = path.join(hostSupportDir, `lib${archive.id}.a`);
		return {
			id: archive.id,
			owner,
			sources: [...archive.sources],
			requiredSymbols: [...archive.requiredSymbols],
			objects,
			path: archivePath,
			compileCommands: objects.map((object) => [
				llvmInputs.hostSupport.tools.cxx,
				...hostSupportCompileFlags,
				'-c',
				object.source,
				'-o',
				object.path
			]),
			archiveCommand: [
				llvmInputs.hostSupport.tools.ar,
				'rcD',
				archivePath,
				...objects.map((object) => object.path)
			],
			ranlibCommand: [llvmInputs.hostSupport.tools.ranlib, '-D', archivePath]
		};
	});
	const compilerHostObjectCompileFlags = [
		`--target=${contract.manifest.target}`,
		`--sysroot=${wasiSysroot}`,
		'-Oz',
		'-ffunction-sections',
		'-fdata-sections',
		'-D_GNU_SOURCE',
		...llvmInputs.hostSupport.definitions.map((definition) => `-D${definition}`),
		...llvmInputs.hostSupport.includeRoots.map((root) => `-I${root}`),
		`-ffile-prefix-map=${patchedSourceRoot}=/tinygo`,
		`-fdebug-prefix-map=${patchedSourceRoot}=/tinygo`
	];
	const compilerHostObjects = COMPILER_HOST_OBJECTS.map((object) => {
		const source = path.join(patchedSourceRoot, object.source);
		const outputPath = path.join(compilerHostObjectDir, `${object.id}.o`);
		return {
			...object,
			source,
			path: outputPath,
			compileCommand: [
				llvmInputs.hostSupport.tools.cxx,
				...compilerHostObjectCompileFlags,
				'-x',
				object.language,
				...object.flags,
				'-c',
				source,
				'-o',
				outputPath
			]
		};
	});
	const targetConfig = {
		inherits: ['wasip1'],
		scheduler: 'none',
		'default-stack-size': COMPILER_HOST_STACK_SIZE,
		'build-tags': ['byollvm', 'osusergo'],
		cflags: [
			`--sysroot=${wasiSysroot}`,
			'-D_GNU_SOURCE',
			'-D__STDC_CONSTANT_MACROS',
			'-D__STDC_FORMAT_MACROS',
			'-D__STDC_LIMIT_MACROS',
			...llvmInputs.hostSupport.definitions.map(
				(definition) => `-D${definition}`
			),
			...includeRoots.map((root) => `-I${root}`)
		],
		ldflags: [
			'--threads=1',
			'--thinlto-jobs=1',
			'-z',
			`stack-size=${COMPILER_HOST_STACK_SIZE}`,
			`-L${wasiLibraryDir}`,
			`-L${wasiCxxLibraryDir}`,
			...hostSupportArchives.map((archive) => archive.path),
			...staticArchives,
			...wasiLibraries.map((library) => `-l${library.name}`),
			llvmInputs.hostSupport.compilerRuntime.path,
			filteredWasiLibcPath
		]
	};
	const packageGraph = [...contract.lock.compilerIdentity.requiredPackages];
	assert(
		new Set(packageGraph).size === packageGraph.length,
		'TinyGo compiler package graph contains duplicate packages'
	);
	assert(
		packageGraph.includes('github.com/tinygo-org/tinygo/cgo'),
		'TinyGo compiler package graph must include upstream cgo/libclang'
	);
	const buildCommand = [
		options.nativeTinyGo,
		'build',
		`-target=${targetConfigPath}`,
		'-tags=byollvm osusergo',
		'-opt=z',
		`-interp-timeout=${COMPILER_INTERP_TIMEOUT}`,
		'-no-debug',
		'-work',
		`-o=${compilerBitcodePath}`,
		'./cmd/tinygo-browser-adapter'
	];
	const acceptanceFixtureDirectory = path.join(
		producerRoot,
		path.dirname(contract.manifest.acceptance.fixture)
	);
	const runtimeProbeFixtureDirectory = path.join(
		producerRoot,
		path.dirname(contract.manifest.rootArchive.runtimeProbe.fixture)
	);
	const mergedRootCommand = [
		options.nativeTinyGo,
		'list',
		'-json',
		`-target=${RUNTIME_PROFILE.target}`,
		`-scheduler=${RUNTIME_PROFILE.scheduler}`,
		`-gc=${RUNTIME_PROFILE.gc}`,
		`-opt=${RUNTIME_PROFILE.opt}`,
		'runtime'
	];
	const runtimeProbeCommand = [
		options.nativeTinyGo,
		'build',
		`-target=${RUNTIME_PROFILE.target}`,
		`-scheduler=${RUNTIME_PROFILE.scheduler}`,
		`-gc=${RUNTIME_PROFILE.gc}`,
		`-opt=${RUNTIME_PROFILE.opt}`,
		`-panic=${RUNTIME_PROFILE.panicStrategy}`,
		'-no-debug',
		'-p=1',
		'-x',
		'-work',
		`-o=${runtimeProbePath}`,
		'.'
	];
	const linkCommand = [
		options.nativeWasmLd,
		'--stack-first',
		'--no-demangle',
		...targetConfig.ldflags,
		'--strip-debug',
		'--compress-relocations',
		'-o',
		compilerPath,
		compilerBitcodePath,
		...compilerHostObjects.map((object) => object.path),
		'-mllvm',
		'-mcpu=generic',
		'-mllvm',
		`-mattr=${COMPILER_HOST_FEATURES}`,
		'--lto-O2',
		'-mllvm',
		'--rotation-max-header-size=0'
	];
	const compilerReceiptSeed = {
		inputs: {
			manifestSha256: contract.inputs.manifestSha256,
			sourcesLockSha256: contract.inputs.sourcesLockSha256,
			sourceReceiptSha256: sha256(sourceReceiptBytes)
		},
		source: {
			tinygoCommit: contract.lock.tinygo.commit,
			goLlvmCommit: contract.lock.goLlvm.commit,
			llvmCommit: contract.lock.llvm.commit
		},
		build: {
			entrypoint: {
				mode: 'upstream-compiler-adapter',
				upstreamModule: contract.lock.tinygo.module,
				referenceCliFile: contract.lock.compilerIdentity.entrypoint
			},
			hostTarget: contract.manifest.target,
			cgoEnabled: true,
			llvmLinkage: 'in-process-c-api',
			hostCompileFallback: false,
			packageGraph,
			compileProtocol: {
				version: contract.manifest.compileProtocol.version,
				format: contract.manifest.compileProtocol.format,
				capabilities: [...contract.manifest.compileProtocol.capabilities]
			},
			compileOutputs: [...contract.manifest.compileProtocol.outputs],
			runtimeProfile: { ...RUNTIME_PROFILE },
			rootArchive: structuredClone(contract.manifest.rootArchive),
			finalization: {
				linker: contract.manifest.finalization.linker,
				optimizer: contract.manifest.finalization.optimizer,
				linkArguments: []
			}
		}
	};

	return {
		schemaVersion: 1,
		format: BUILD_RECEIPT_FORMAT,
		producerId: contract.manifest.producerId,
		status: 'dry-run',
		errorMessage: null,
		inputs: {
			...compilerReceiptSeed.inputs,
				buildScriptSha256: sha256(scriptBytes),
				adapterPatchSha256: sha256(patchBytes),
				goLlvmPatchSha256: sha256(goLlvmPatchBytes),
				goToolchainPatchSha256: sha256(goToolchainPatchBytes),
				llvmReceiptSha256: sha256(llvmReceiptBytes),
				hostSupportRequirementsSha256: sha256(
					Buffer.from(JSON.stringify(llvmInputs.hostSupport))
				)
		},
		source: compilerReceiptSeed.source,
		patch: {
			path: patchEntry.path,
			sha256: patchEntry.sha256,
			status: 'pending',
			patchedPaths
		},
		llvm: {
			format: llvmReceipt.format,
			status: llvmReceipt.status,
			projects: [...llvmReceipt.projects],
			receiptPath: options.llvmReceiptPath,
			receiptSha256: sha256(llvmReceiptBytes),
			libclang: {
				archive: { ...llvmReceipt.libclangEvidence.archive },
				headers: llvmInputs.requiredHeaders.map((header) => ({ ...header })),
				staticLinkArchiveTargets: [...llvmReceipt.libclang.staticLinkArchiveTargets]
			},
				staticArchives: llvmReceipt.libclang.staticLinkArchiveTargets.map((target) => ({
					target,
					...llvmInputs.outputByTarget.get(target)
				})),
				requiredFinalLinkLibraries: [...llvmReceipt.requiredFinalLinkLibraries],
				wasiLibraries,
				compilerRuntime: { ...llvmInputs.hostSupport.compilerRuntime },
				compilerRtBuiltins: {
					source: compilerRtBuiltinsSource,
					archivePath: compilerRtBuiltinsArchivePath,
					archived: null
				},
				wasiLibc: {
					sourcePath: wasiLibcSourcePath,
					filteredPath: filteredWasiLibcPath,
					removedMember: WASI_LIBC_MALLOC_MEMBER,
					source: null,
					filtered: null
				},
				wasiSysroot,
				wasiLibraryDirs: {
					base: wasiLibraryDir,
					cxx: wasiCxxLibraryDir
				}
			},
		paths: {
			sourceRoot: options.sourceRoot,
			goLlvmSourceRoot: options.goLlvmSourceRoot,
			patchedSourceRoot,
			patchedGoLlvmRoot,
			goToolchainExtractDir,
			goToolchainRoot,
			goWorkPath,
			buildDir: options.buildDir,
			hostSupportDir,
			compilerHostObjectDir,
			hostLinkInputDir,
			browserRootOverlayDir,
			browserWasiLibcIncludeDir,
			browserCxxIncludeDir,
			wasiCxxIncludeDir,
			runtimeClosureDir,
			runtimeProfileDir,
			runtimeProbePath,
			artifactDir: options.artifactDir,
			targetConfigPath,
			compilerBitcodePath,
			compilerPath,
			tinygoRootPath
		},
		nativeTinyGo: {
			path: options.nativeTinyGo,
			expectedVersion: contract.lock.tinygo.version,
			version: null,
			binary: null,
			rootDiscovery: options.nativeTinyGoRoot ? 'explicit' : 'compiler',
			root: null,
			rootIdentity: null,
			clangResource: null,
			binaryenDiscovery: options.wasmOpt ? 'explicit' : 'compiler',
				binaryen: null
			},
		nativeLinker: {
			path: options.nativeWasmLd,
			version: null,
			binary: null
		},
			goLlvmSource: {
				module: contract.lock.goLlvm.module,
				version: contract.lock.goLlvm.version,
				sum: contract.lock.goLlvm.sum,
				files: goLlvmSourceEvidence,
				patch: {
					path: goLlvmPatchEntry.path,
					sha256: goLlvmPatchEntry.sha256,
					status: 'pending'
				}
			},
		goToolchain: {
			module: contract.lock.goToolchain.module,
			version: contract.lock.goToolchain.version,
			platform: contract.lock.goToolchain.platform,
			archivePath: options.goToolchainArchive,
			expectedArchive: {
				bytes: contract.lock.goToolchain.archiveBytes,
				sha256: contract.lock.goToolchain.archiveSha256
			},
			archive: null,
			root: goToolchainRoot,
			patchedSource: { ...contract.lock.goToolchain.patchedSource },
			patch: {
				path: goToolchainPatchEntry.path,
				sha256: goToolchainPatchEntry.sha256,
				status: 'pending'
			}
		},
			hostSupport: {
				status: 'planned',
				target: contract.manifest.target,
				tools: { ...llvmInputs.hostSupport.tools },
				compileFlags: hostSupportCompileFlags,
				includeRoots: [...llvmInputs.hostSupport.includeRoots],
				definitions: [...llvmInputs.hostSupport.definitions],
				toolEvidence: null,
				sources: {
					tinygo: tinyGoSourceEvidence,
					goLlvm: goLlvmSourceEvidence
				},
					archives: hostSupportArchives,
				filteredWasiLibc: {
						path: filteredWasiLibcPath,
						removedMember: WASI_LIBC_MALLOC_MEMBER
					},
					outputs: null,
					compilerObjects: {
						status: 'planned',
						compileFlags: compilerHostObjectCompileFlags,
						inputs: compilerHostObjects,
						outputs: null
					}
			},
		build: {
			...compilerReceiptSeed.build,
			command: buildCommand,
			linkCommand,
			generatedEmbedObjects: {
				status: 'planned',
				discoveryRoot: path.join(options.buildDir, 'tmp'),
				outputDir: hostLinkInputDir,
				filenamePattern: EMBED_OBJECT_PATTERN.source,
				outputs: null
			},
			imports: null,
			environment: {
				CGO_ENABLED: '1',
				GOFLAGS: '-mod=readonly',
				GOROOT: goToolchainRoot,
				GOVERSION: contract.lock.goToolchain.version,
				GOWORK: goWorkPath,
				SOURCE_DATE_EPOCH: '0',
				GOCACHE: path.join(options.buildDir, 'cache'),
				TMPDIR: path.join(options.buildDir, 'tmp')
			},
			targetConfig
		},
		rootArchive: {
			format: 'wasm-llvm-tinygo-browser-root-v1',
			paths: [...ROOT_ARCHIVE_PATHS],
			omittedTinyGoPaths: [
				'lib except receipt-bound Clang, wasi-libc, and libc++ headers'
			],
			cgoHeaderClosure: {
				status: 'planned',
				clangResource: null,
				wasiLibc: null,
				libCxx: null
			},
			mergedGoRoot: {
				status: 'planned',
				command: mergedRootCommand,
				workingDirectory: acceptanceFixtureDirectory,
				path: null,
				identity: null
			},
			runtimeClosure: {
				status: 'planned',
				format: RUNTIME_CLOSURE_FORMAT,
				profile: { ...RUNTIME_PROFILE },
				command: runtimeProbeCommand,
				workingDirectory: runtimeProbeFixtureDirectory,
				manifest: null,
				probe: null
			},
			tarArguments: [
				'--dereference',
				'--sort=name',
				'--mtime=@0',
				'--owner=0',
				'--group=0',
				'--numeric-owner',
				'--format=gnu'
			],
			gzipArguments: ['-n', '-9']
		},
		compilerReceiptSeed,
		assets: null,
		acceptance: {
			status: 'pending',
			reason:
				'The browser host must compile the locked fixture, run raw WASI LLD and Binaryen, and record execution before producer-receipt.json can be issued.'
		},
		_sourceReceipt: sourceReceipt,
		_manifest: contract.manifest
	};
}

export async function buildBrowserCompiler(
	options,
	{
		producerRoot = PRODUCER_ROOT,
		contract = null,
		verifySource = verifyTinyGoSourceReceipt,
		run = runCommand,
		copySource = cp,
		inspectFile = inspectBuildFile
	} = {}
) {
	assertPathOutsideRoot(options.receiptPath, options.sourceRoot, '--receipt');
	assertPathOutsideRoot(
		options.receiptPath,
		options.goLlvmSourceRoot,
		'--receipt'
	);
	let receipt;
	try {
		receipt = await createBrowserCompilerBuildPlan(options, {
			producerRoot,
			contract,
			verifySource
		});
		const reverseCheck = await run(
			'git',
			['apply', '--reverse', '--check', path.join(producerRoot, receipt.patch.path)],
			{ cwd: receipt.paths.sourceRoot, capture: true }
		);
		assert(
			reverseCheck.exitCode !== 0,
			'TinyGo adapter patch is already applied to the supposedly clean source checkout'
		);
		const applyCheck = await run(
			'git',
			['apply', '--check', path.join(producerRoot, receipt.patch.path)],
			{ cwd: receipt.paths.sourceRoot, capture: true }
		);
		assert(
			applyCheck.exitCode === 0,
			`TinyGo adapter patch does not apply to ${receipt.source.tinygoCommit}:\n${applyCheck.stderr}${applyCheck.stdout}`
		);
		receipt.patch.status = 'applicable';

		const goLlvmPatchPath = path.join(
			producerRoot,
			receipt.goLlvmSource.patch.path
		);
		const goLlvmReverseCheck = await run(
			'git',
			['apply', '--reverse', '--check', goLlvmPatchPath],
			{ cwd: receipt.paths.goLlvmSourceRoot, capture: true }
		);
		assert(
			goLlvmReverseCheck.exitCode !== 0,
			'go-llvm WASI alias patch is already applied to the supposedly clean source tree'
		);
		const goLlvmApplyCheck = await run(
			'git',
			['apply', '--check', goLlvmPatchPath],
			{ cwd: receipt.paths.goLlvmSourceRoot, capture: true }
		);
		assert(
			goLlvmApplyCheck.exitCode === 0,
			`go-llvm WASI alias patch does not apply:\n${goLlvmApplyCheck.stderr}${goLlvmApplyCheck.stdout}`
		);
		receipt.goLlvmSource.patch.status = 'applicable';

		const goToolchainArchive = await inspectFile(options.goToolchainArchive);
		assert(
			goToolchainArchive.bytes === receipt.goToolchain.expectedArchive.bytes &&
				goToolchainArchive.sha256 === receipt.goToolchain.expectedArchive.sha256,
			'Go bootstrap archive differs from the locked go1.24.6 linux-amd64 distribution'
		);
		receipt.goToolchain.archive = goToolchainArchive;

		await access(options.nativeWasmLd, fsConstants.X_OK);
		receipt.nativeLinker.binary = await inspectFile(options.nativeWasmLd);
		const linkerVersionResult = await run(options.nativeWasmLd, ['--version'], {
			capture: true
		});
		const linkerVersion = `${linkerVersionResult.stdout}\n${linkerVersionResult.stderr}`.trim();
		const linkerMajor = /\bLLD\s+(\d+)\./u.exec(linkerVersion);
		assert(
			linkerVersionResult.exitCode === 0 &&
				linkerMajor &&
				Number.parseInt(linkerMajor[1], 10) >= 21,
			`external wasm-ld must be LLD 21 or newer, received ${linkerVersion || '<empty>'}`
		);
		receipt.nativeLinker.version = linkerVersion;

		await access(options.nativeTinyGo, fsConstants.X_OK);
		receipt.nativeTinyGo.binary = await inspectFile(options.nativeTinyGo);
		const versionResult = await run(options.nativeTinyGo, ['version'], {
			capture: true,
			env: { ...process.env, TINYGOROOT: '' }
		});
		assert(
			versionResult.exitCode === 0,
			`native TinyGo version check failed: ${versionResult.stderr}`
		);
		const compilerVersion = versionResult.stdout.trim();
		assert(
			new RegExp(
				`^tinygo version ${receipt.nativeTinyGo.expectedVersion.replaceAll('.', '\\.')}(?:\\s|$).*LLVM version 20\\.`,
				'u'
			).test(compilerVersion),
			`native compiler must be TinyGo ${receipt.nativeTinyGo.expectedVersion} with LLVM 20, received ${compilerVersion || '<empty>'}`
		);
		receipt.nativeTinyGo.version = compilerVersion;

		const rootResult = await run(options.nativeTinyGo, ['env', 'TINYGOROOT'], {
			capture: true,
			env: {
				...process.env,
				TINYGOROOT: options.nativeTinyGoRoot ?? ''
			}
		});
		assert(
			rootResult.exitCode === 0,
			`native TinyGo root discovery failed: ${rootResult.stderr}`
		);
		const nativeTinyGoRoot = rootResult.stdout.trim();
		assert(path.isAbsolute(nativeTinyGoRoot), 'native TinyGo reported a non-absolute TINYGOROOT');
		if (options.nativeTinyGoRoot) {
			assert(
				path.resolve(nativeTinyGoRoot) === options.nativeTinyGoRoot,
				'native TinyGo did not accept the explicit TINYGOROOT'
			);
		}
		const lockedIdentitySources = new Map(
			receipt._sourceReceipt.compilerIdentity.sourceFiles.map((source) => [
				source.path,
				source
			])
		);
		const rootIdentity = [];
		for (const relativePath of NATIVE_ROOT_IDENTITY_PATHS) {
			const lockedSource = lockedIdentitySources.get(relativePath);
			assert(
				lockedSource,
				`source receipt does not bind native TINYGOROOT identity file ${relativePath}`
			);
			const absolutePath = path.join(nativeTinyGoRoot, relativePath);
			const evidence = await inspectFile(absolutePath);
			assert(
				evidence.bytes === lockedSource.bytes &&
					evidence.sha256 === lockedSource.sha256,
				`native TINYGOROOT ${relativePath} differs from the verified TinyGo checkout`
			);
			rootIdentity.push({
				path: relativePath,
				bytes: evidence.bytes,
				sha256: evidence.sha256
			});
		}
		receipt.nativeTinyGo.root = nativeTinyGoRoot;
		receipt.nativeTinyGo.rootIdentity = rootIdentity;
		const clangResourceDir =
			options.clangResourceDir ??
			path.join(nativeTinyGoRoot, 'lib', 'clang');
		const clangResourceHeaders = [];
		for (const relativePath of CLANG_RESOURCE_IDENTITY_PATHS) {
			clangResourceHeaders.push(
				{
					name: relativePath,
					...(await inspectFile(path.join(clangResourceDir, relativePath)))
				}
			);
		}
		receipt.nativeTinyGo.clangResource = {
			path: clangResourceDir,
			archivePath: path.join(
				receipt.paths.patchedSourceRoot,
				'lib',
				'clang'
			),
			headers: clangResourceHeaders,
			source: await inspectDirectoryTree(clangResourceDir),
			archived: null
		};
		receipt.build.targetConfig.cflags.unshift(
			`-resource-dir=${receipt.nativeTinyGo.clangResource.archivePath}`
		);
		for (const [candidatePath, label] of [
			[options.buildDir, '--build-dir'],
			[options.artifactDir, '--artifact-dir'],
			[options.receiptPath, '--receipt']
		]) {
			assertPathOutsideRoot(candidatePath, nativeTinyGoRoot, label);
		}
		receipt.build.environment.TINYGOROOT = receipt.paths.patchedSourceRoot;
		const wasmOptResult = await run(options.nativeTinyGo, ['env', 'WASMOPT'], {
			capture: true,
			env: {
				...process.env,
				TINYGOROOT: nativeTinyGoRoot,
				WASMOPT: options.wasmOpt ?? ''
			}
		});
		assert(
			wasmOptResult.exitCode === 0,
			`native TinyGo Binaryen discovery failed: ${wasmOptResult.stderr}`
		);
		const wasmOptPath = wasmOptResult.stdout.trim();
		assert(
			path.isAbsolute(wasmOptPath),
			'native TinyGo reported a non-absolute Binaryen wasm-opt path'
		);
		if (options.wasmOpt) {
			assert(
				path.resolve(wasmOptPath) === options.wasmOpt,
				'native TinyGo did not accept the explicit Binaryen wasm-opt path'
			);
		}
		await access(wasmOptPath, fsConstants.X_OK);
		const wasmOptVersionResult = await run(wasmOptPath, ['--version'], {
			capture: true
		});
		assert(
			wasmOptVersionResult.exitCode === 0 &&
				/wasm-opt version/iu.test(
					`${wasmOptVersionResult.stdout}\n${wasmOptVersionResult.stderr}`
				),
			'native TinyGo Binaryen wasm-opt version check failed'
		);
		receipt.nativeTinyGo.binaryen = {
			...(await inspectFile(wasmOptPath)),
			version: `${wasmOptVersionResult.stdout}\n${wasmOptVersionResult.stderr}`.trim()
		};
		receipt.build.environment.WASMOPT = wasmOptPath;

		if (options.execute) {
			await Promise.all([
				...Object.values(receipt.hostSupport.tools).map((toolPath) =>
					access(toolPath, fsConstants.X_OK)
				),
				...receipt.hostSupport.includeRoots.map((includeRoot) => access(includeRoot)),
				...receipt.llvm.wasiLibraries.map((library) => access(library.path)),
				access(receipt.llvm.compilerRuntime.path),
				access(receipt.llvm.wasiLibc.sourcePath),
				access(receipt.paths.wasiCxxIncludeDir)
			]);
			receipt.hostSupport.toolEvidence = await Promise.all(
				Object.entries(receipt.hostSupport.tools).map(async ([name, toolPath]) => ({
					name,
					...(await inspectFile(toolPath))
				}))
			);
			for (const output of receipt.llvm.staticArchives) {
				const evidence = await inspectFile(output.path, { staticArchive: true });
				assert(
					evidence.bytes === output.bytes && evidence.sha256 === output.sha256,
					`LLVM static archive evidence mismatch for ${output.target}`
				);
			}
			for (const header of receipt.llvm.libclang.headers) {
				const evidence = await inspectFile(header.path);
				assert(
					evidence.bytes === header.bytes && evidence.sha256 === header.sha256,
					`libclang header evidence mismatch for ${header.name}`
				);
			}
			for (const library of receipt.llvm.wasiLibraries) {
				const evidence = await inspectFile(library.path, {
					staticArchive: true
				});
				library.bytes = evidence.bytes;
				library.sha256 = evidence.sha256;
			}
			const compilerRuntimeEvidence = await inspectFile(
				receipt.llvm.compilerRuntime.path,
				{ staticArchive: true }
			);
			assert(
				compilerRuntimeEvidence.bytes === receipt.llvm.compilerRuntime.bytes &&
					compilerRuntimeEvidence.sha256 === receipt.llvm.compilerRuntime.sha256,
				'WASI compiler runtime evidence differs from the LLVM receipt'
			);

			assert(
				!(await lstat(receipt.paths.patchedSourceRoot).catch((error) => {
					if (error?.code === 'ENOENT') return null;
					throw error;
				})),
				`refusing to replace existing patched source directory ${receipt.paths.patchedSourceRoot}`
			);
			assert(
				!(await lstat(receipt.paths.hostSupportDir).catch((error) => {
					if (error?.code === 'ENOENT') return null;
					throw error;
				})),
				`refusing to replace existing host-support directory ${receipt.paths.hostSupportDir}`
			);
			for (const [directoryPath, label] of [
				[receipt.paths.patchedGoLlvmRoot, 'patched go-llvm'],
				[receipt.paths.goToolchainExtractDir, 'Go toolchain extraction'],
				[receipt.paths.hostLinkInputDir, 'host link input'],
				[receipt.paths.browserRootOverlayDir, 'browser root overlay'],
				[receipt.build.environment.TMPDIR, 'build temporary']
			]) {
				assert(
					!(await lstat(directoryPath).catch((error) => {
						if (error?.code === 'ENOENT') return null;
						throw error;
					})),
					`refusing to replace existing ${label} directory ${directoryPath}`
				);
			}
			for (const outputPath of [
				receipt.paths.targetConfigPath,
				receipt.paths.goWorkPath,
				receipt.paths.compilerBitcodePath,
				receipt.paths.runtimeProbePath,
				receipt.paths.compilerPath,
				receipt.paths.tinygoRootPath
			]) {
				assert(
					!(await lstat(outputPath).catch((error) => {
						if (error?.code === 'ENOENT') return null;
						throw error;
					})),
					`refusing to overwrite existing artifact ${outputPath}`
				);
			}
			await Promise.all([
				mkdir(receipt.paths.buildDir, { recursive: true }),
				mkdir(receipt.paths.artifactDir, { recursive: true }),
				mkdir(receipt.build.environment.GOCACHE, { recursive: true }),
				mkdir(receipt.build.environment.TMPDIR, { recursive: true }),
				mkdir(receipt.paths.hostLinkInputDir, { recursive: true }),
				mkdir(receipt.paths.compilerHostObjectDir, { recursive: true }),
				mkdir(receipt.paths.runtimeProfileDir, { recursive: true }),
				...receipt.hostSupport.archives.map((archive) =>
					mkdir(path.dirname(archive.objects[0].path), { recursive: true })
				)
			]);
			await copySource(receipt.paths.sourceRoot, receipt.paths.patchedSourceRoot, {
				recursive: true,
				preserveTimestamps: true,
				filter: (sourcePath) =>
					path.relative(receipt.paths.sourceRoot, sourcePath).split(path.sep)[0] !== '.git'
			});
			await copySource(receipt.paths.goLlvmSourceRoot, receipt.paths.patchedGoLlvmRoot, {
				recursive: true,
				preserveTimestamps: true,
				filter: (sourcePath) =>
					path.relative(receipt.paths.goLlvmSourceRoot, sourcePath).split(path.sep)[0] !== '.git'
			});
			await chmod(receipt.paths.patchedGoLlvmRoot, 0o755);
			const goLlvmApplied = await run(
				'git',
				['apply', path.join(producerRoot, receipt.goLlvmSource.patch.path)],
				{ cwd: receipt.paths.patchedGoLlvmRoot, capture: true }
			);
			assert(
				goLlvmApplied.exitCode === 0,
				`go-llvm WASI alias patch application failed:\n${goLlvmApplied.stderr}${goLlvmApplied.stdout}`
			);
			await access(path.join(receipt.paths.patchedGoLlvmRoot, GO_LLVM_ALIAS_PATH));
			receipt.goLlvmSource.patch.status = 'applied';

			const extractedGo = await run(
				'unzip',
				[
					'-q',
					receipt.goToolchain.archivePath,
					'-d',
					receipt.paths.goToolchainExtractDir
				]
			);
			assert(
				extractedGo.exitCode === 0,
				`Go bootstrap extraction failed with ${extractedGo.signal ?? extractedGo.exitCode}`
			);
			const goVersionFile = await readFile(
				path.join(receipt.paths.goToolchainRoot, 'VERSION'),
				'utf8'
			);
			assert(
				goVersionFile.split(/\r?\n/u)[0] === receipt.goToolchain.version,
				'extracted Go bootstrap VERSION differs from the source lock'
			);
			const goExecSource = await inspectFile(
				path.join(receipt.paths.goToolchainRoot, receipt.goToolchain.patchedSource.path)
			);
			assert(
				goExecSource.sha256 === receipt.goToolchain.patchedSource.sha256,
				'extracted Go os/exec source differs from the locked distribution'
			);
			const goToolchainApplied = await run(
				'git',
				['apply', path.join(producerRoot, receipt.goToolchain.patch.path)],
				{ cwd: receipt.paths.goToolchainRoot, capture: true }
			);
			assert(
				goToolchainApplied.exitCode === 0,
				`Go WASI process patch application failed:\n${goToolchainApplied.stderr}${goToolchainApplied.stdout}`
			);
			receipt.goToolchain.patch.status = 'applied';
			await writeFile(
				receipt.paths.goWorkPath,
				`go 1.24.0\n\nuse ${JSON.stringify(receipt.paths.patchedSourceRoot)}\n\nreplace ${receipt.goLlvmSource.module} => ${JSON.stringify(receipt.paths.patchedGoLlvmRoot)}\n`,
				'utf8'
			);
			const archivedClangResource = await lstat(
				receipt.nativeTinyGo.clangResource.archivePath
			).catch((error) => {
				if (error?.code === 'ENOENT') return null;
				throw error;
			});
			if (!archivedClangResource) {
				await cp(
					receipt.nativeTinyGo.clangResource.path,
					receipt.nativeTinyGo.clangResource.archivePath,
					{
						recursive: true,
						preserveTimestamps: true
					}
				);
			}
			for (const header of receipt.nativeTinyGo.clangResource.headers) {
				const archivedHeader = await inspectFile(
					path.join(
						receipt.nativeTinyGo.clangResource.archivePath,
						header.name
					)
				);
				assert(
					archivedHeader.bytes === header.bytes &&
						archivedHeader.sha256 === header.sha256,
					`archived Clang resource header ${header.name} differs from the bootstrap input`
				);
			}
			receipt.nativeTinyGo.clangResource.archived = await inspectDirectoryTree(
				receipt.nativeTinyGo.clangResource.archivePath
			);
			assert(
				receipt.nativeTinyGo.clangResource.archived.files ===
					receipt.nativeTinyGo.clangResource.source.files &&
					receipt.nativeTinyGo.clangResource.archived.bytes ===
						receipt.nativeTinyGo.clangResource.source.bytes &&
					receipt.nativeTinyGo.clangResource.archived.sha256 ===
						receipt.nativeTinyGo.clangResource.source.sha256,
				'archived Clang resource closure differs from the bootstrap input'
			);
			const archivedCompilerRtBuiltins = await lstat(
				receipt.llvm.compilerRtBuiltins.archivePath
			).catch((error) => {
				if (error?.code === 'ENOENT') return null;
				throw error;
			});
			if (!archivedCompilerRtBuiltins) {
				await cp(
					receipt.llvm.compilerRtBuiltins.source.path,
					receipt.llvm.compilerRtBuiltins.archivePath,
					{ recursive: true, preserveTimestamps: true }
				);
			} else {
				assert(
					archivedCompilerRtBuiltins.isDirectory(),
					`${receipt.llvm.compilerRtBuiltins.archivePath} is not a directory`
				);
			}
			receipt.llvm.compilerRtBuiltins.archived = await inspectDirectoryTree(
				receipt.llvm.compilerRtBuiltins.archivePath
			);
			assert(
				receipt.llvm.compilerRtBuiltins.archived.files ===
					receipt.llvm.compilerRtBuiltins.source.files &&
					receipt.llvm.compilerRtBuiltins.archived.bytes ===
						receipt.llvm.compilerRtBuiltins.source.bytes &&
					receipt.llvm.compilerRtBuiltins.archived.sha256 ===
						receipt.llvm.compilerRtBuiltins.source.sha256,
				'archived compiler-rt builtins differ from the pinned LLVM source tree'
			);
			const applied = await run(
				'git',
				['apply', path.join(producerRoot, receipt.patch.path)],
				{ cwd: receipt.paths.patchedSourceRoot, capture: true }
			);
			assert(
				applied.exitCode === 0,
				`TinyGo adapter patch application failed:\n${applied.stderr}${applied.stdout}`
			);
			await access(path.join(receipt.paths.patchedSourceRoot, ADAPTER_ENTRYPOINT));
			receipt.patch.status = 'applied';

			const hostSupportOutputs = [];
			const hostSupportEnvironment = {
				...process.env,
				SOURCE_DATE_EPOCH: '0',
				ZERO_AR_DATE: '1'
			};
			const compilerObjectOutputs = [];
			for (const object of receipt.hostSupport.compilerObjects.inputs) {
				const sourceEvidence = await inspectFile(object.source);
				const compiled = await run(
					object.compileCommand[0],
					object.compileCommand.slice(1),
					{ env: hostSupportEnvironment }
				);
				assert(
					compiled.exitCode === 0,
					`${object.id} compiler host object failed with ${compiled.signal ?? compiled.exitCode}`
				);
				compilerObjectOutputs.push({
					id: object.id,
					source: {
						path: object.source,
						bytes: sourceEvidence.bytes,
						sha256: sourceEvidence.sha256
					},
					...(await inspectFile(object.path, { wasmObject: true }))
				});
			}
			receipt.hostSupport.compilerObjects.status = 'passed';
			receipt.hostSupport.compilerObjects.outputs = compilerObjectOutputs;
			for (const archive of receipt.hostSupport.archives) {
				const objectEvidence = [];
				for (const command of archive.compileCommands) {
					const compiled = await run(command[0], command.slice(1), {
						env: hostSupportEnvironment
					});
					assert(
						compiled.exitCode === 0,
						`${archive.id} C++ compilation failed with ${compiled.signal ?? compiled.exitCode}`
					);
				}
				for (const object of archive.objects) {
					objectEvidence.push(
						await inspectFile(object.path, { wasmObject: true })
					);
				}
				const archived = await run(
					archive.archiveCommand[0],
					archive.archiveCommand.slice(1),
					{ env: hostSupportEnvironment }
				);
				assert(
					archived.exitCode === 0,
					`${archive.id} deterministic archive failed with ${archived.signal ?? archived.exitCode}`
				);
				const indexed = await run(
					archive.ranlibCommand[0],
					archive.ranlibCommand.slice(1),
					{ env: hostSupportEnvironment }
				);
				assert(
					indexed.exitCode === 0,
					`${archive.id} deterministic archive index failed with ${indexed.signal ?? indexed.exitCode}`
				);
				const archiveEvidence = await inspectFile(archive.path, {
					staticArchive: true
				});
				const symbols = await run(
					receipt.hostSupport.tools.nm,
					['--defined-only', archive.path],
					{ capture: true }
				);
				assert(
					symbols.exitCode === 0,
					`${archive.id} symbol verification failed: ${symbols.stderr}`
				);
				const symbolTokens = new Set(symbols.stdout.split(/\s+/u).filter(Boolean));
				for (const symbol of archive.requiredSymbols) {
					assert(
						symbolTokens.has(symbol),
						`${archive.id} is missing required upstream symbol ${symbol}`
					);
				}
				hostSupportOutputs.push({
					id: archive.id,
					path: archive.path,
					bytes: archiveEvidence.bytes,
					sha256: archiveEvidence.sha256,
					sources: [...archive.sources],
					members: archive.objects.map((object) => path.basename(object.path)),
					objects: objectEvidence,
					requiredSymbols: [...archive.requiredSymbols]
				});
			}
			const wasiLibcSourceEvidence = await inspectFile(
				receipt.llvm.wasiLibc.sourcePath,
				{ staticArchive: true }
			);
			const wasiLibcMembers = await run(
				receipt.hostSupport.tools.ar,
				['t', receipt.llvm.wasiLibc.sourcePath],
				{ capture: true }
			);
			assert(
				wasiLibcMembers.exitCode === 0 &&
					wasiLibcMembers.stdout.split(/\r?\n/u).includes(WASI_LIBC_MALLOC_MEMBER),
				`WASI libc does not contain the expected ${WASI_LIBC_MALLOC_MEMBER} allocator member`
			);
			await cp(receipt.llvm.wasiLibc.sourcePath, receipt.llvm.wasiLibc.filteredPath, {
				preserveTimestamps: true
			});
			const removedAllocator = await run(
				receipt.hostSupport.tools.ar,
				['d', receipt.llvm.wasiLibc.filteredPath, WASI_LIBC_MALLOC_MEMBER],
				{ env: hostSupportEnvironment }
			);
			assert(
				removedAllocator.exitCode === 0,
				`WASI libc allocator removal failed with ${removedAllocator.signal ?? removedAllocator.exitCode}`
			);
			const indexedWasiLibc = await run(
				receipt.hostSupport.tools.ranlib,
				['-D', receipt.llvm.wasiLibc.filteredPath],
				{ env: hostSupportEnvironment }
			);
			assert(
				indexedWasiLibc.exitCode === 0,
				`filtered WASI libc indexing failed with ${indexedWasiLibc.signal ?? indexedWasiLibc.exitCode}`
			);
			const filteredMembers = await run(
				receipt.hostSupport.tools.ar,
				['t', receipt.llvm.wasiLibc.filteredPath],
				{ capture: true }
			);
			assert(
				filteredMembers.exitCode === 0 &&
					!filteredMembers.stdout.split(/\r?\n/u).includes(WASI_LIBC_MALLOC_MEMBER),
				'filtered WASI libc still contains the dlmalloc allocator'
			);
			const filteredWasiLibcEvidence = await inspectFile(
				receipt.llvm.wasiLibc.filteredPath,
				{ staticArchive: true }
			);
			receipt.llvm.wasiLibc.source = wasiLibcSourceEvidence;
			receipt.llvm.wasiLibc.filtered = filteredWasiLibcEvidence;
			receipt.hostSupport.filteredWasiLibc = {
				...receipt.hostSupport.filteredWasiLibc,
				bytes: filteredWasiLibcEvidence.bytes,
				sha256: filteredWasiLibcEvidence.sha256
			};
			receipt.hostSupport.status = 'passed';
			receipt.hostSupport.outputs = hostSupportOutputs;

			await writeFile(
				receipt.paths.targetConfigPath,
				`${JSON.stringify(receipt.build.targetConfig, null, 2)}\n`,
				'utf8'
			);

			const buildEnvironment = {
				...process.env,
				...receipt.build.environment,
				PATH: `${path.join(receipt.paths.goToolchainRoot, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`
			};
			const built = await run(receipt.build.command[0], receipt.build.command.slice(1), {
				cwd: receipt.paths.patchedSourceRoot,
				env: buildEnvironment
			});
			assert(
				built.exitCode === 0,
				`native TinyGo browser compiler build failed with ${built.signal ?? built.exitCode}`
			);
			receipt.build.bitcode = await inspectFile(receipt.paths.compilerBitcodePath, {
				llvmBitcode: true
			});
			const pendingDirectories = [receipt.build.generatedEmbedObjects.discoveryRoot];
			const discoveredEmbedObjects = [];
			while (pendingDirectories.length > 0) {
				const directory = pendingDirectories.pop();
				const entries = await readdir(directory, { withFileTypes: true });
				entries.sort((left, right) =>
					left.name < right.name ? -1 : left.name > right.name ? 1 : 0
				);
				for (const entry of entries) {
					const entryPath = path.join(directory, entry.name);
					if (entry.isDirectory()) {
						pendingDirectories.push(entryPath);
						continue;
					}
					const match = entry.isFile() ? EMBED_OBJECT_PATTERN.exec(entry.name) : null;
					if (match) discoveredEmbedObjects.push({ embeddedFileHash: match[1], path: entryPath });
				}
			}
			discoveredEmbedObjects.sort((left, right) => {
				if (left.embeddedFileHash !== right.embeddedFileHash) {
					return left.embeddedFileHash < right.embeddedFileHash ? -1 : 1;
				}
				return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
			});
			assert(
				discoveredEmbedObjects.length > 0,
				'native TinyGo build did not retain its generated embed object inputs'
			);
			const embedObjectByHash = new Map();
			for (const discovered of discoveredEmbedObjects) {
				const evidence = await inspectFile(discovered.path, { wasmObject: true });
				const prior = embedObjectByHash.get(discovered.embeddedFileHash);
				if (prior) {
					assert(
						prior.bytes === evidence.bytes && prior.sha256 === evidence.sha256,
						`TinyGo generated conflicting embed objects for ${discovered.embeddedFileHash}`
					);
					continue;
				}
				embedObjectByHash.set(discovered.embeddedFileHash, evidence);
			}
			const embedObjectOutputs = [];
			for (const [embeddedFileHash, sourceEvidence] of embedObjectByHash) {
				const outputPath = path.join(
					receipt.paths.hostLinkInputDir,
					`embed-${embeddedFileHash}.o`
				);
				await cp(sourceEvidence.path, outputPath, { preserveTimestamps: true });
				const outputEvidence = await inspectFile(outputPath, { wasmObject: true });
				assert(
					outputEvidence.bytes === sourceEvidence.bytes &&
						outputEvidence.sha256 === sourceEvidence.sha256,
					`copied TinyGo embed object ${embeddedFileHash} differs from its generated input`
				);
				embedObjectOutputs.push({ embeddedFileHash, ...outputEvidence });
			}
			receipt.build.generatedEmbedObjects.status = 'captured';
			receipt.build.generatedEmbedObjects.outputs = embedObjectOutputs;
			const compilerInputIndex = receipt.build.linkCommand.indexOf(
				receipt.paths.compilerBitcodePath
			);
			assert(compilerInputIndex >= 0, 'external link command is missing compiler bitcode');
			receipt.build.linkCommand.splice(
				compilerInputIndex + 1,
				0,
				...embedObjectOutputs.map((output) => output.path)
			);
			const linked = await run(
				receipt.build.linkCommand[0],
				receipt.build.linkCommand.slice(1),
				{ cwd: receipt.paths.patchedSourceRoot, env: buildEnvironment }
			);
			assert(
				linked.exitCode === 0,
				`external wasm-ld browser compiler link failed with ${linked.signal ?? linked.exitCode}`
			);
			receipt.build.linkedCompiler = await inspectFile(receipt.paths.compilerPath, {
				wasmObject: true
			});
			const linkedCompilerModule = new WebAssembly.Module(
				await readFile(receipt.paths.compilerPath)
			);
			receipt.build.imports = WebAssembly.Module.imports(linkedCompilerModule);
			const nonWasiImports = receipt.build.imports.filter(
				(entry) => entry.module !== 'wasi_snapshot_preview1'
			);
			assert(
				nonWasiImports.length === 0,
				`browser compiler retains non-WASI imports: ${nonWasiImports
					.map((entry) => `${entry.module}.${entry.name}`)
					.join(', ')}`
			);

			const browserProfileEnvironment = {
				...process.env,
				GO111MODULE: 'off',
				GOROOT: receipt.paths.goToolchainRoot,
				GOVERSION: receipt.goToolchain.version,
				GOWORK: 'off',
				TINYGOROOT: receipt.paths.patchedSourceRoot,
				WASMOPT: receipt.nativeTinyGo.binaryen.path
			};
			const mergedRootResult = await run(
				receipt.rootArchive.mergedGoRoot.command[0],
				receipt.rootArchive.mergedGoRoot.command.slice(1),
				{
					cwd: receipt.rootArchive.mergedGoRoot.workingDirectory,
					env: browserProfileEnvironment,
					capture: true
				}
			);
			assert(
				mergedRootResult.exitCode === 0,
				`native TinyGo merged GOROOT discovery failed: ${mergedRootResult.stderr}`
			);
			let runtimePackage;
			try {
				runtimePackage = JSON.parse(mergedRootResult.stdout);
			} catch (error) {
				throw new Error(
					`native TinyGo merged GOROOT discovery did not emit one JSON package: ${error instanceof Error ? error.message : String(error)}`
				);
			}
			assert(
				runtimePackage?.ImportPath === 'runtime' &&
					path.isAbsolute(runtimePackage?.Root ?? ''),
				'native TinyGo runtime package did not identify an absolute merged GOROOT'
			);
			const mergedGoRoot = runtimePackage.Root;
			const mergedRootIdentity = [];
			for (const identity of [
				{
					id: 'tinygo-runtime',
					path: path.join(mergedGoRoot, 'src', 'runtime', 'runtime.go'),
					expectedRoot: receipt.paths.patchedSourceRoot
				},
				{
					id: 'go-standard-library',
					path: path.join(mergedGoRoot, 'src', 'fmt', 'print.go'),
					expectedRoot: receipt.paths.goToolchainRoot
				},
				{
					id: 'go-environment',
					path: path.join(mergedGoRoot, 'go.env'),
					expectedRoot: receipt.paths.goToolchainRoot
				}
			]) {
				const resolvedSource = await realpath(identity.path);
				const relativeSource = path.relative(identity.expectedRoot, resolvedSource);
				assert(
					relativeSource !== '..' &&
						!relativeSource.startsWith(`..${path.sep}`) &&
						!path.isAbsolute(relativeSource),
					`merged GOROOT ${identity.id} does not resolve inside ${identity.expectedRoot}`
				);
				mergedRootIdentity.push({
					id: identity.id,
					resolvedSource,
					...(await inspectFile(identity.path))
				});
			}
			receipt.rootArchive.mergedGoRoot = {
				...receipt.rootArchive.mergedGoRoot,
				status: 'passed',
				path: mergedGoRoot,
				identity: mergedRootIdentity
			};

			const runtimeProbeResult = await run(
				receipt.rootArchive.runtimeClosure.command[0],
				receipt.rootArchive.runtimeClosure.command.slice(1),
				{
					cwd: receipt.rootArchive.runtimeClosure.workingDirectory,
					env: browserProfileEnvironment,
					capture: true
				}
			);
			assert(
				runtimeProbeResult.exitCode === 0,
				`native TinyGo runtime closure probe failed: ${runtimeProbeResult.stderr}`
			);
			const runtimeLinkInputs = parseTinyGoRuntimeLinkTrace(
				`${runtimeProbeResult.stdout}\n${runtimeProbeResult.stderr}`
			);
			const wasiLibcIncludeSource = path.join(
				path.dirname(runtimeLinkInputs.wasiLibc),
				'include'
			);
			const wasiLibcIncludeEvidence = await inspectDirectoryTree(
				wasiLibcIncludeSource
			);
			const wasiCxxIncludeEvidence = await inspectDirectoryTree(
				receipt.paths.wasiCxxIncludeDir
			);
			await mkdir(path.dirname(receipt.paths.browserWasiLibcIncludeDir), {
				recursive: true
			});
			await cp(wasiLibcIncludeSource, receipt.paths.browserWasiLibcIncludeDir, {
				recursive: true,
				preserveTimestamps: true
			});
			await mkdir(path.dirname(receipt.paths.browserCxxIncludeDir), { recursive: true });
			await cp(receipt.paths.wasiCxxIncludeDir, receipt.paths.browserCxxIncludeDir, {
				recursive: true,
				preserveTimestamps: true
			});
			const archivedWasiLibcInclude = await inspectDirectoryTree(
				receipt.paths.browserWasiLibcIncludeDir
			);
			const archivedWasiCxxInclude = await inspectDirectoryTree(
				receipt.paths.browserCxxIncludeDir
			);
			assert(
				archivedWasiLibcInclude.files ===
					wasiLibcIncludeEvidence.files + wasiCxxIncludeEvidence.files &&
					archivedWasiCxxInclude.files === wasiCxxIncludeEvidence.files &&
					archivedWasiCxxInclude.bytes === wasiCxxIncludeEvidence.bytes &&
					archivedWasiCxxInclude.sha256 === wasiCxxIncludeEvidence.sha256,
				'archived libc++ headers differ from the pinned WASI sysroot input'
			);
			receipt.rootArchive.cgoHeaderClosure = {
				status: 'passed',
				clangResource: {
					path: 'lib/clang',
					files: receipt.nativeTinyGo.clangResource.archived.files,
					bytes: receipt.nativeTinyGo.clangResource.archived.bytes,
					sha256: receipt.nativeTinyGo.clangResource.archived.sha256
				},
				wasiLibc: {
					path: 'lib/wasi-libc/include',
					sourcePath: wasiLibcIncludeSource,
					files: wasiLibcIncludeEvidence.files,
					bytes: wasiLibcIncludeEvidence.bytes,
					sha256: wasiLibcIncludeEvidence.sha256
				},
				libCxx: {
					path: 'lib/wasi-libc/include/c++/v1',
					sourcePath: receipt.paths.wasiCxxIncludeDir,
					files: archivedWasiCxxInclude.files,
					bytes: archivedWasiCxxInclude.bytes,
					sha256: archivedWasiCxxInclude.sha256
				}
			};
			const runtimeAssets = [];
			for (const input of [
				{
					id: 'compiler-rt',
					sourcePath: runtimeLinkInputs.compilerRT,
					outputName: 'compiler-rt.a',
					format: 'static-archive'
				},
				{
					id: 'wasi-libc',
					sourcePath: runtimeLinkInputs.wasiLibc,
					outputName: 'wasi-libc.a',
					format: 'static-archive'
				},
				...receipt.llvm.wasiLibraries
					.filter((library) => library.name === 'c++' || library.name === 'c++abi')
					.map((library) => ({
						id: library.name === 'c++' ? 'libcxx' : 'libcxxabi',
						sourcePath: library.path,
						outputName: library.name === 'c++' ? 'libcxx.a' : 'libcxxabi.a',
						format: 'static-archive'
					})),
				...RUNTIME_EXTRA_INPUTS.map((runtimeInput, index) => ({
					id: `extra-${index}`,
					...runtimeInput,
					sourcePath: runtimeLinkInputs.extraFiles[runtimeInput.source]
				}))
			]) {
				const outputPath = path.join(receipt.paths.runtimeProfileDir, input.outputName);
				await copySource(input.sourcePath, outputPath, { preserveTimestamps: true });
				const evidence = await inspectFile(outputPath, {
					staticArchive: input.format === 'static-archive',
					llvmBitcode: input.format === 'llvm-bitcode',
					wasmObject: input.format === 'wasm-object'
				});
				runtimeAssets.push({
					id: input.id,
					...(input.source ? { source: input.source } : {}),
					format: input.format,
					path: path.posix.join('runtime', RUNTIME_PROFILE.id, input.outputName),
					bytes: evidence.bytes,
					sha256: evidence.sha256
				});
			}
			const runtimeManifest = {
				schemaVersion: 1,
				format: RUNTIME_CLOSURE_FORMAT,
				compilerSha256: receipt.build.linkedCompiler.sha256,
				profile: { ...RUNTIME_PROFILE },
				compilerRT: runtimeAssets.find((asset) => asset.id === 'compiler-rt'),
				wasiLibc: runtimeAssets.find((asset) => asset.id === 'wasi-libc'),
				libCxx: runtimeAssets.find((asset) => asset.id === 'libcxx'),
				libCxxAbi: runtimeAssets.find((asset) => asset.id === 'libcxxabi'),
				extraFiles: Object.fromEntries(
					runtimeAssets
						.filter((asset) => asset.source)
						.map((asset) => [asset.source, asset])
				)
			};
			const runtimeManifestPath = path.join(
				receipt.paths.runtimeProfileDir,
				'manifest.json'
			);
			await writeFile(
				runtimeManifestPath,
				`${JSON.stringify(runtimeManifest, null, 2)}\n`,
				'utf8'
			);
			const runtimeManifestEvidence = await inspectFile(runtimeManifestPath);
			receipt.rootArchive.runtimeClosure = {
				...receipt.rootArchive.runtimeClosure,
				status: 'passed',
				manifest: {
					path: path.posix.join('runtime', RUNTIME_PROFILE.id, 'manifest.json'),
					bytes: runtimeManifestEvidence.bytes,
					sha256: runtimeManifestEvidence.sha256,
					value: runtimeManifest
				},
				probe: await inspectFile(receipt.paths.runtimeProbePath, { wasmObject: true })
			};

			const temporaryTarPath = path.join(receipt.paths.buildDir, 'tinygoroot.tar');
			const temporaryGzipPath = `${temporaryTarPath}.gz`;
			try {
				const archived = await run(
					'tar',
					[
						...receipt.rootArchive.tarArguments,
						'-cf',
						temporaryTarPath,
						'-C',
						receipt.rootArchive.mergedGoRoot.path,
						'go.env',
						'src',
						'-C',
						receipt.paths.patchedSourceRoot,
						'targets',
						'go.mod',
						'go.sum',
						'lib/clang',
						'-C',
						receipt.paths.browserRootOverlayDir,
						'lib/wasi-libc/include',
						'runtime'
					],
					{ env: { ...process.env, SOURCE_DATE_EPOCH: '0' } }
				);
				assert(
					archived.exitCode === 0,
					`deterministic TinyGo root tar failed with ${archived.signal ?? archived.exitCode}`
				);
				const compressed = await run(
					'gzip',
					[...receipt.rootArchive.gzipArguments, '-f', temporaryTarPath],
					{ env: { ...process.env, SOURCE_DATE_EPOCH: '0' } }
				);
				assert(
					compressed.exitCode === 0,
					`deterministic TinyGo root gzip failed with ${compressed.signal ?? compressed.exitCode}`
				);
				await rename(temporaryGzipPath, receipt.paths.tinygoRootPath);
			} finally {
				await Promise.all([
					rm(temporaryTarPath, { force: true }),
					rm(temporaryGzipPath, { force: true })
				]);
			}

			const [compilerBytes, tinygoRootBytes] = await Promise.all([
				readFile(receipt.paths.compilerPath),
				readFile(receipt.paths.tinygoRootPath)
			]);
			verifyTinyGoArtifactPayloads({
				compilerBytes,
				tinygoRootBytes,
				manifest: receipt._manifest
			});
			const [compilerEvidence, rootEvidence] = await Promise.all([
				inspectFile(receipt.paths.compilerPath),
				inspectFile(receipt.paths.tinygoRootPath)
			]);
			receipt.assets = [
				{
					path: 'tinygo-compiler.wasm',
					bytes: compilerEvidence.bytes,
					sha256: compilerEvidence.sha256
				},
				{
					path: 'tinygoroot.tar.gz',
					bytes: rootEvidence.bytes,
					sha256: rootEvidence.sha256
				}
			];
			receipt.status = 'passed';
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!receipt) {
			receipt = {
				schemaVersion: 1,
				format: BUILD_RECEIPT_FORMAT,
				producerId: 'wasm-llvm/tinygo-browser',
				status: 'failed',
				errorMessage: message
			};
		} else {
			receipt.status = 'failed';
			receipt.errorMessage = message;
		}
	}

	let receiptPathIsSafe = true;
	if (receipt?.nativeTinyGo?.root) {
		try {
			assertPathOutsideRoot(
				options.receiptPath,
				receipt.nativeTinyGo.root,
				'--receipt'
			);
		} catch {
			receiptPathIsSafe = false;
		}
	}
	if (receipt && receiptPathIsSafe) {
		delete receipt._sourceReceipt;
		delete receipt._manifest;
		await mkdir(path.dirname(options.receiptPath), { recursive: true });
		await writeFile(options.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
	}
	if (receipt.status === 'failed') throw new Error(receipt.errorMessage);
	return receipt;
}

function usage() {
	return `Usage: node scripts/build-browser-compiler.mjs --source-root <tinygo> --source-receipt <receipt.json> --go-llvm-source-root <go-llvm> --llvm-receipt <llvm-build.json> --tinygo <native-tinygo> --native-wasm-ld <wasm-ld> --go-toolchain-archive <go.zip> --artifact-dir <dir> [options]

Verifies the clean TinyGo v0.40.1 checkout and the passed LLVM+Clang WASI receipt,
the locked go-llvm C++ bindings, and a native TinyGo bootstrap compiler. It then
plans deterministic WASI host-support archives and a real upstream
cmd/tinygo-browser-adapter build. The default only performs read-only
verification and writes a dry-run receipt. No standard Go fallback is permitted.

Options:
  --go-llvm-source-root <dir>  Locked go-llvm module source tree
  --native-wasm-ld <file>      External native wasm-ld used for the final compiler link
  --go-toolchain-archive <zip> Locked Go 1.24.6 linux-amd64 toolchain archive
  --native-tinygo-root <dir>   Verified source root used by the native bootstrap
  --clang-resource-dir <dir>   LLVM 20 built-in headers archived with TinyGo
  --wasm-opt <file>             Explicit Binaryen executable used by the bootstrap
  --build-dir <dir>            Isolated patched source and build directory
  --receipt <file>             Deterministic intermediate build receipt
  --execute                    Build host-support archives and compiler assets`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		const options = parseBuildBrowserCompilerArgs(process.argv.slice(2));
		if (options.help) console.log(usage());
		else {
			const receipt = await buildBrowserCompiler(options);
			console.log(`${receipt.status}: ${options.receiptPath}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
