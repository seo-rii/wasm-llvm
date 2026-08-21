import assert from 'node:assert/strict';
import {
	access,
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
	buildBrowserCompiler,
	createBrowserCompilerBuildPlan,
	inspectBuildFile,
	parseBuildBrowserCompilerArgs,
	parseTinyGoRuntimeLinkTrace,
	validateLlvmWasiReceipt
} from '../scripts/build-browser-compiler.mjs';
import {
	loadTinyGoProducerContract,
	sha256
} from '../scripts/source-contract.mjs';

const tempDirs = [];
const TINYGO_HOST_FILES = [
	'builder/cc1as.cpp',
	'builder/clang.cpp',
	'builder/lld.cpp',
	'builder/cc1as.h',
	'builder/tools-builtin.go'
];
const NATIVE_ROOT_FILES = [
	'go.mod',
	'main.go',
	'cgo/libclang.go',
	'builder/tools-builtin.go'
];
const GO_LLVM_HOST_FILES = [
	'IRBindings.cpp',
	'IRBindings.h',
	'SupportBindings.cpp',
	'SupportBindings.h',
	'backports.cpp',
	'backports.h'
];
const HOST_ARCHIVES = [
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
const HOST_DEFINITIONS = [
	'CINDEX_NO_EXPORTS',
	'_WASI_EMULATED_GETPID',
	'_WASI_EMULATED_MMAN',
	'_WASI_EMULATED_PROCESS_CLOCKS',
	'_WASI_EMULATED_SIGNAL'
];
const WASM_HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const LLVM_BITCODE_HEADER = Buffer.from([0x42, 0x43, 0xc0, 0xde]);

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((directory) =>
			rm(directory, { recursive: true, force: true })
		)
	);
});

function encodeUleb(value) {
	const bytes = [];
	do {
		let byte = value & 0x7f;
		value >>>= 7;
		if (value !== 0) byte |= 0x80;
		bytes.push(byte);
	} while (value !== 0);
	return Buffer.from(bytes);
}

function wasmWithIdentity(strings) {
	const name = Buffer.from('tinygo.provenance');
	const payload = Buffer.from(strings.join('\0'));
	const section = Buffer.concat([encodeUleb(name.length), name, payload]);
	return Buffer.concat([
		WASM_HEADER,
		Buffer.from([0x00]),
		encodeUleb(section.length),
		section
	]);
}

async function writeFixtureFile(root, relativePath, contents) {
	const outputPath = path.join(root, relativePath);
	await mkdir(path.dirname(outputPath), { recursive: true });
	await writeFile(outputPath, contents);
	return outputPath;
}

async function fileEvidence(filePath) {
	const bytes = await readFile(filePath);
	return { path: filePath, bytes: bytes.length, sha256: sha256(bytes) };
}

async function createFixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), 'wasm-llvm-tinygo-browser-build-'));
	tempDirs.push(root);
	const sourceRoot = path.join(root, 'tinygo');
	const goLlvmSourceRoot = path.join(root, 'go-llvm');
	const nativeRoot = path.join(root, 'native-tinygo-root');
	const buildDir = path.join(root, 'build');
	const artifactDir = path.join(root, 'artifacts');
	const sourceReceiptPath = path.join(root, 'source-receipt.json');
	const llvmReceiptPath = path.join(root, 'llvm-receipt.json');
	const receiptPath = path.join(root, 'browser-build-receipt.json');
	const nativeTinyGo = path.join(root, 'bin', 'tinygo-bootstrap');
	const nativeWasmLd = path.join(root, 'bin', 'wasm-ld');
	const goToolchainArchive = path.join(root, 'go-toolchain.zip');
	const clangResourceDir = path.join(nativeRoot, 'lib', 'clang');
	const wasmOpt = path.join(nativeRoot, 'bin', 'wasm-opt');
	const contract = structuredClone(await loadTinyGoProducerContract());
	const goToolchainArchiveBytes = Buffer.from('locked Go toolchain archive fixture\n');
	const goExecSource = Buffer.from('package exec\n\nfunc fixture() {}\n');
	await writeFile(goToolchainArchive, goToolchainArchiveBytes);
	contract.lock.goToolchain.archiveBytes = goToolchainArchiveBytes.length;
	contract.lock.goToolchain.archiveSha256 = sha256(goToolchainArchiveBytes);
	contract.lock.goToolchain.patchedSource.sha256 = sha256(goExecSource);

	const tinyGoContents = new Map();
	for (const relativePath of new Set([
		...TINYGO_HOST_FILES,
		...NATIVE_ROOT_FILES,
		'go.sum'
	])) {
		const contents = Buffer.from(`locked TinyGo fixture: ${relativePath}\n`);
		tinyGoContents.set(relativePath, contents);
		await writeFixtureFile(sourceRoot, relativePath, contents);
		const lockEntry = contract.lock.compilerIdentity.requiredSources.find(
			(entry) => entry.path === relativePath
		);
		if (lockEntry) lockEntry.sha256 = sha256(contents);
	}
	for (const directory of ['src', 'targets', 'lib']) {
		await writeFixtureFile(
			sourceRoot,
			path.join(directory, 'fixture.txt'),
			`${directory}\n`
		);
	}
	await writeFixtureFile(
		sourceRoot,
		'src/runtime/asm_tinygowasm.S',
		'.global tinygo_getCurrentStackPointer\n'
	);
	await writeFixtureFile(sourceRoot, 'src/runtime/runtime.go', 'package runtime\n');

	const goLlvmContents = new Map();
	for (const relativePath of GO_LLVM_HOST_FILES) {
		const contents = Buffer.from(`locked go-llvm fixture: ${relativePath}\n`);
		goLlvmContents.set(relativePath, contents);
		await writeFixtureFile(goLlvmSourceRoot, relativePath, contents);
		contract.lock.goLlvm.hostSupportSources.find(
			(entry) => entry.path === relativePath
		).sha256 = sha256(contents);
	}

	for (const relativePath of NATIVE_ROOT_FILES) {
		await writeFixtureFile(nativeRoot, relativePath, tinyGoContents.get(relativePath));
	}
	await writeFixtureFile(nativeRoot, 'go.sum', tinyGoContents.get('go.sum'));
	await writeFixtureFile(nativeRoot, 'src/fixture.txt', 'src\n');
	await writeFixtureFile(nativeRoot, 'targets/fixture.txt', 'targets\n');
	await writeFixtureFile(nativeRoot, 'lib/fixture.txt', 'lib\n');
	await writeFixtureFile(
		clangResourceDir,
		'include/stddef.h',
		'clang stddef fixture\n'
	);
	await writeFixtureFile(
		clangResourceDir,
		'include/stdint.h',
		'clang stdint fixture\n'
	);
	await writeFixtureFile(path.dirname(nativeTinyGo), path.basename(nativeTinyGo), '#!/bin/sh\n');
	await writeFixtureFile(path.dirname(nativeWasmLd), path.basename(nativeWasmLd), '#!/bin/sh\n');
	await writeFixtureFile(path.dirname(wasmOpt), path.basename(wasmOpt), '#!/bin/sh\n');
	await chmod(nativeTinyGo, 0o755);
	await chmod(nativeWasmLd, 0o755);
	await chmod(wasmOpt, 0o755);

	const sourceReceipt = {
		compilerIdentity: {
			sourceFiles: [...tinyGoContents].map(([relativePath, contents]) => ({
				path: relativePath,
				bytes: contents.length,
				sha256: sha256(contents)
			}))
		}
	};
	await writeFile(sourceReceiptPath, `${JSON.stringify(sourceReceipt, null, 2)}\n`);

	const wasiSdk = path.join(root, 'wasi-sdk');
	const wasiSysroot = path.join(wasiSdk, 'share', 'wasi-sysroot');
	const tools = {
		cxx: path.join(wasiSdk, 'bin', 'clang++'),
		ar: path.join(wasiSdk, 'bin', 'llvm-ar'),
		ranlib: path.join(wasiSdk, 'bin', 'llvm-ranlib'),
		nm: path.join(wasiSdk, 'bin', 'llvm-nm')
	};
	for (const toolPath of Object.values(tools)) {
		await writeFixtureFile(path.dirname(toolPath), path.basename(toolPath), 'tool\n');
		await chmod(toolPath, 0o755);
	}
	await mkdir(wasiSysroot, { recursive: true });
	await writeFixtureFile(
		path.join(wasiSysroot, 'include', 'c++', 'v1'),
		'string',
		'// libc++ string fixture\n'
	);
	for (const library of ['wasi-emulated-mman', 'dl', 'c++', 'c++abi']) {
		const libraryDir = path.join(
			wasiSysroot,
			'lib',
			contract.manifest.target,
			library === 'c++' || library === 'c++abi' ? 'noeh' : ''
		);
		await writeFixtureFile(
			libraryDir,
			`lib${library}.a`,
			Buffer.from('!<arch>\nfixture')
		);
	}
	await writeFixtureFile(
		path.join(wasiSysroot, 'lib', contract.manifest.target),
		'libc.a',
		Buffer.from('!<arch>\nfixture')
	);

	const llvmSource = path.join(root, 'llvm-project');
	const llvmBuild = path.join(root, 'llvm-build');
	await writeFixtureFile(
		path.join(llvmSource, 'compiler-rt', 'lib', 'builtins'),
		'absvdi2.c',
		'int fixture_compiler_rt_builtin(void) { return 0; }\n'
	);
	const includeRoots = [
		path.join(llvmSource, 'llvm', 'include'),
		path.join(llvmBuild, 'include'),
		path.join(llvmSource, 'clang', 'include'),
		path.join(llvmBuild, 'tools', 'clang', 'include'),
		path.join(llvmSource, 'lld', 'include'),
		path.join(llvmBuild, 'tools', 'lld', 'include')
	];
	await Promise.all(includeRoots.map((includeRoot) => mkdir(includeRoot, { recursive: true })));
	const headerPaths = {
		'clang-c/Index.h': await writeFixtureFile(
			includeRoots[2],
			'clang-c/Index.h',
			'clang index\n'
		),
		'llvm-c/Core.h': await writeFixtureFile(
			includeRoots[0],
			'llvm-c/Core.h',
			'llvm core\n'
		),
		'llvm/Config/llvm-config.h': await writeFixtureFile(
			includeRoots[1],
			'llvm/Config/llvm-config.h',
			'#define LLVM_VERSION_MAJOR 20\n'
		)
	};
	const requiredHeaders = await Promise.all(
		Object.entries(headerPaths).map(async ([name, headerPath]) => ({
			name,
			...(await fileEvidence(headerPath))
		}))
	);

	const archiveTargets = [
		'libclang',
		'clangDriver',
		'lldWasm',
		'LLVMCore',
		'LLVMSupport',
		'LLVMWebAssemblyCodeGen'
	];
	const outputs = [];
	for (const target of archiveTargets) {
		const archivePath = path.join(
			llvmBuild,
			'lib',
			target === 'libclang' ? 'libclang.a' : `lib${target}.a`
		);
		await writeFixtureFile(path.dirname(archivePath), path.basename(archivePath), Buffer.from('!<arch>\nfixture'));
		outputs.push({ target, ...(await fileEvidence(archivePath)) });
	}
	const libclangArchive = outputs.find((output) => output.target === 'libclang');
	const compilerRuntimePath = await writeFixtureFile(
		path.join(wasiSdk, 'lib', 'clang', 'fixture'),
		'libclang_rt.builtins.a',
		Buffer.from('!<arch>\nfixture')
	);
	const compilerRuntime = {
		...(await fileEvidence(compilerRuntimePath)),
		requiredSymbols: ['__multi3', '__udivti3']
	};
	const upstreamPatchPath = await writeFixtureFile(
		root,
		'yowasp-llvm-wasi-host.patch',
		'locked YoWASP LLVM WASI host patch\n'
	);
	const llvmReceipt = {
		format: 'wasm-llvm-tinygo-llvm-wasi-static-v1',
		status: 'passed',
		inputs: {
			sourcesLockSha256: contract.inputs.sourcesLockSha256,
			configSha256: 'a'.repeat(64),
			producerScriptSha256: 'b'.repeat(64),
			patchSha256: contract.lock.patches.find(
				(entry) => entry.path === 'patches/llvm-wasi-c-api-config.patch'
			).sha256,
			upstreamPatchCommit: contract.lock.wasiHostPatch.commit,
			upstreamPatchParent: contract.lock.wasiHostPatch.parent
		},
		upstreamPatchStatus: 'applied',
		upstreamPatchEvidence: await fileEvidence(upstreamPatchPath),
		patchStatus: 'applied',
		source: {
			commit: contract.lock.llvm.commit
		},
		host: {
			compilerTarget: contract.manifest.target
		},
		projects: ['clang', 'lld'],
		paths: {
			sourceRoot: llvmSource,
			wasiSysroot
		},
		outputs,
		libclang: {
			target: 'libclang',
			archivePath: libclangArchive.path,
			includeRoot: includeRoots[2],
			staticLinkArchiveTargets: archiveTargets,
			requiredHeaders: requiredHeaders.map(({ name, path: headerPath }) => ({
				name,
				path: headerPath
			}))
		},
		libclangEvidence: {
			archive: { ...libclangArchive },
			headers: requiredHeaders
		},
		hostSupportRequirements: {
			target: contract.manifest.target,
			tools,
			includeRoots,
			definitions: HOST_DEFINITIONS,
			archives: HOST_ARCHIVES,
			staticLinkArchiveTargets: archiveTargets,
			compilerRuntime
		},
		requiredFinalLinkLibraries: [
			'wasi-emulated-mman',
			'dl',
			'c++',
			'c++abi'
		]
	};
	await writeFile(llvmReceiptPath, `${JSON.stringify(llvmReceipt, null, 2)}\n`);

	const options = parseBuildBrowserCompilerArgs([
		'--source-root',
		sourceRoot,
		'--source-receipt',
		sourceReceiptPath,
		'--go-llvm-source-root',
		goLlvmSourceRoot,
		'--llvm-receipt',
		llvmReceiptPath,
		'--tinygo',
		nativeTinyGo,
		'--native-wasm-ld',
		nativeWasmLd,
		'--go-toolchain-archive',
		goToolchainArchive,
		'--native-tinygo-root',
		nativeRoot,
		'--clang-resource-dir',
		clangResourceDir,
		'--wasm-opt',
		wasmOpt,
		'--artifact-dir',
		artifactDir,
		'--build-dir',
		buildDir,
		'--receipt',
		receiptPath
	]);

	return {
		root,
		sourceRoot,
		goLlvmSourceRoot,
		nativeRoot,
		nativeTinyGo,
		nativeWasmLd,
		goToolchainArchive,
		goExecSource,
		clangResourceDir,
		wasmOpt,
		buildDir,
		artifactDir,
		sourceReceiptPath,
		llvmReceiptPath,
		receiptPath,
		contract,
		sourceReceipt,
		llvmReceipt,
		options,
		tools
	};
}

function result({ exitCode = 0, stdout = '', stderr = '', signal = null } = {}) {
	return { exitCode, stdout, stderr, signal };
}

function createCommandRunner(
	fixture,
	{ execute = false, badVersion = false, omitEmbedObject = false } = {}
) {
	const calls = [];
	const runner = async (command, args, runOptions = {}) => {
		calls.push({ command, args, runOptions });
		if (command === 'git') {
			if (args.includes('--reverse')) return result({ exitCode: 1, stderr: 'not applied' });
			if (args[0] === 'apply' && args.length === 2) {
				if (path.basename(runOptions.cwd) === 'go-llvm-wasi') {
					await writeFixtureFile(
						runOptions.cwd,
						'tinygo_cgo_unsigned.go',
						'package llvm\n'
					);
				} else if (path.basename(runOptions.cwd) === 'tinygo-v0.40.1-wasi') {
					await writeFixtureFile(
						runOptions.cwd,
						'cmd/tinygo-browser-adapter/main.go',
						'package main\n'
					);
					await writeFixtureFile(
						runOptions.cwd,
						'cgo/libclang_stubs.c',
						'void tinygo_wasm_clang_getTypeSpelling(void) {}\n'
					);
				}
			}
			return result();
		}
		if (command === fixture.nativeWasmLd && args[0] === '--version') {
			return result({ stdout: 'LLD 21.0.0 (fixture)\n' });
		}
		if (command === fixture.nativeTinyGo && args[0] === 'version') {
			return result({
				stdout: badVersion
					? 'go version go1.24.0 linux/amd64\n'
					: 'tinygo version 0.40.1 linux/amd64 (using go version go1.24.0 and LLVM version 20.1.1)\n'
			});
		}
		if (
			command === fixture.nativeTinyGo &&
			args[0] === 'env' &&
			args[1] === 'TINYGOROOT'
		) {
			return result({ stdout: `${fixture.nativeRoot}\n` });
		}
		if (
			command === fixture.nativeTinyGo &&
			args[0] === 'env' &&
			args[1] === 'WASMOPT'
		) {
			return result({ stdout: `${fixture.wasmOpt}\n` });
		}
		if (command === fixture.wasmOpt && args[0] === '--version') {
			return result({ stdout: 'wasm-opt version 123\n' });
		}
		if (!execute) throw new Error(`unexpected dry-run command: ${command} ${args.join(' ')}`);
		if (command === 'unzip') {
			const extractRoot = path.join(
				args[args.indexOf('-d') + 1],
				fixture.contract.lock.goToolchain.archiveRoot
			);
			await writeFixtureFile(extractRoot, 'VERSION', `${fixture.contract.lock.goToolchain.version}\ntime fixture\n`);
			await writeFixtureFile(
				extractRoot,
				fixture.contract.lock.goToolchain.patchedSource.path,
				fixture.goExecSource
			);
			await writeFixtureFile(extractRoot, 'bin/go', '#!/bin/sh\n');
			await writeFixtureFile(extractRoot, 'src/fmt/print.go', 'package fmt\n');
			await writeFixtureFile(extractRoot, 'go.env', 'GOTOOLCHAIN=local\n');
			return result();
		}
		if (command === fixture.tools.cxx) {
			const outputIndex = args.indexOf('-o');
			await writeFixtureFile(
				path.dirname(args[outputIndex + 1]),
				path.basename(args[outputIndex + 1]),
				WASM_HEADER
			);
			return result();
		}
		if (command === fixture.tools.ar) {
			if (args[0] === 't') {
				return result({
					stdout: path.basename(args[1]) === 'libc-no-dlmalloc.a'
						? 'fixture.o\n'
						: 'dlmalloc.c.obj\nfixture.o\n'
				});
			}
			if (args[0] === 'd') return result();
			await writeFixtureFile(
				path.dirname(args[1]),
				path.basename(args[1]),
				Buffer.from('!<arch>\nfixture')
			);
			return result();
		}
		if (command === fixture.tools.ranlib) return result();
		if (command === fixture.tools.nm) {
			return result({
				stdout: Object.values(HOST_ARCHIVES)
					.flatMap((archive) => archive.requiredSymbols)
					.map((symbol) => `00000000 T ${symbol}`)
					.join('\n')
			});
		}
		if (command === fixture.nativeTinyGo && args[0] === 'list') {
			const mergedRoot = path.join(fixture.root, 'merged-goroot');
			await mkdir(path.join(mergedRoot, 'src'), { recursive: true });
			await symlink(
				path.join(runOptions.env.TINYGOROOT, 'src', 'runtime'),
				path.join(mergedRoot, 'src', 'runtime'),
				'dir'
			);
			await symlink(
				path.join(runOptions.env.GOROOT, 'src', 'fmt'),
				path.join(mergedRoot, 'src', 'fmt'),
				'dir'
			);
			await symlink(
				path.join(runOptions.env.GOROOT, 'go.env'),
				path.join(mergedRoot, 'go.env'),
				'file'
			);
			return result({
				stdout: `${JSON.stringify({ ImportPath: 'runtime', Root: mergedRoot })}\n`
			});
		}
		if (
			command === fixture.nativeTinyGo &&
			args[0] === 'build' &&
			args.includes('-x')
		) {
			const output = args.find((argument) => argument.startsWith('-o=')).slice(3);
			await writeFixtureFile(path.dirname(output), path.basename(output), WASM_HEADER);
			const runtimeCache = path.join(fixture.root, 'runtime-cache');
			const compilerRT = await writeFixtureFile(
				path.join(runtimeCache, 'compiler-rt-wasm32-unknown-wasi-generic'),
				'lib.a',
				Buffer.from('!<arch>\nfixture')
			);
			const extraFiles = await Promise.all(
				[
					['asm-tinygowasm.bc', WASM_HEADER],
					['gc-boehm.bc', LLVM_BITCODE_HEADER],
					['task-asyncify-wasm.bc', WASM_HEADER]
				].map(
					([name, header]) =>
						writeFixtureFile(
							runtimeCache,
							name,
							Buffer.concat([header, Buffer.from(name)])
						)
				)
			);
			const wasiLibc = await writeFixtureFile(
				path.join(runtimeCache, 'wasi-libc-wasm32-unknown-wasi-generic'),
				'lib.a',
				Buffer.from('!<arch>\nfixture')
			);
			await writeFixtureFile(
				path.dirname(wasiLibc),
				'include/stdio.h',
				'int puts(const char *);\n'
			);
			return result({
				stderr: `${fixture.nativeWasmLd} /tmp/main.o ${compilerRT} ${extraFiles.join(' ')} ${wasiLibc} -o ${output}\n`
			});
		}
		if (command === fixture.nativeTinyGo && args[0] === 'build') {
			const output = args.find((argument) => argument.startsWith('-o=')).slice(3);
			await writeFixtureFile(
				path.dirname(output),
				path.basename(output),
				Buffer.concat([LLVM_BITCODE_HEADER, Buffer.from('fixture bitcode')])
			);
			if (!omitEmbedObject) {
				await writeFixtureFile(
					path.join(runOptions.env.TMPDIR, 'tinygo-fixture'),
					'embed-7ce70651d3f6149edd504627b500a7e5-123.o',
					Buffer.concat([WASM_HEADER, Buffer.from('fixture embed object')])
				);
			}
			return result();
		}
		if (command === fixture.nativeWasmLd) {
			const output = args[args.indexOf('-o') + 1];
			await writeFixtureFile(
				path.dirname(output),
				path.basename(output),
				wasmWithIdentity(
					fixture.contract.manifest.upstreamCompiler.requiredArtifactIdentityStrings
				)
			);
			return result();
		}
		if (command === 'tar') {
			const output = args[args.indexOf('-cf') + 1];
			await writeFixtureFile(path.dirname(output), path.basename(output), 'tar fixture');
			return result();
		}
		if (command === 'gzip') {
			const input = args.at(-1);
			await writeFixtureFile(
				path.dirname(`${input}.gz`),
				path.basename(`${input}.gz`),
				gzipSync(await readFile(input))
			);
			return result();
		}
		throw new Error(`unexpected execute command: ${command} ${args.join(' ')}`);
	};
	return { calls, runner };
}

async function copyPatchedSource(source, destination) {
	await cp(source, destination, { recursive: true });
	if (path.basename(destination) === 'go-llvm-wasi') {
		await chmod(destination, 0o555);
	}
}

test('parses a dry-run plan and rejects a standard Go compiler path', async () => {
	const fixture = await createFixture();
	assert.equal(fixture.options.execute, false);
	assert.equal(fixture.options.goLlvmSourceRoot, fixture.goLlvmSourceRoot);
	assert.equal(fixture.options.nativeTinyGoRoot, fixture.nativeRoot);
	assert.equal(fixture.options.clangResourceDir, fixture.clangResourceDir);
	assert.equal(fixture.options.wasmOpt, fixture.wasmOpt);
	assert.equal(fixture.options.nativeWasmLd, fixture.nativeWasmLd);
	assert.equal(fixture.options.goToolchainArchive, fixture.goToolchainArchive);
	assert.deepEqual(parseBuildBrowserCompilerArgs(['--help']), { help: true });
	assert.throws(
		() =>
			parseBuildBrowserCompilerArgs([
				'--source-root',
				'source',
				'--source-receipt',
				'source.json',
				'--go-llvm-source-root',
				'go-llvm',
				'--llvm-receipt',
				'llvm.json',
				'--tinygo',
				'/usr/bin/go',
				'--native-wasm-ld',
				'/usr/bin/wasm-ld',
				'--go-toolchain-archive',
				'/tmp/go-toolchain.zip',
				'--artifact-dir',
				'artifacts'
			]),
		/not the standard Go compiler/u
	);
	assert.throws(
		() => parseBuildBrowserCompilerArgs([]),
		/--source-root is required/u
	);
});

test('extracts the exact TinyGo runtime closure from one linker trace', () => {
	const closure = parseTinyGoRuntimeLinkTrace(
		'/opt/wasm-ld /tmp/main.o /cache/compiler-rt-profile/lib.a /cache/asm.bc /cache/gc.bc /cache/task.bc /cache/wasi-libc-profile/lib.a -o out.wasm\n'
	);
	assert.equal(closure.compilerRT, '/cache/compiler-rt-profile/lib.a');
	assert.equal(closure.wasiLibc, '/cache/wasi-libc-profile/lib.a');
	assert.deepEqual(Object.values(closure.extraFiles), [
		'/cache/asm.bc',
		'/cache/gc.bc',
		'/cache/task.bc'
	]);
	assert.throws(
		() => parseTinyGoRuntimeLinkTrace(''),
		/exactly one wasm-ld command/u
	);
	assert.throws(
		() =>
			parseTinyGoRuntimeLinkTrace(
				'/opt/wasm-ld /cache/compiler-rt-profile/lib.a /cache/asm.bc /cache/wasi-libc-profile/lib.a\n'
			),
		/3 extra bitcode files/u
	);
});

test('validates passed LLVM, Clang, libclang, LLD, and host-support requirements', async () => {
	const fixture = await createFixture();
	const validated = validateLlvmWasiReceipt(fixture.llvmReceipt, {
		contract: fixture.contract
	});
	assert.equal(validated.requiredHeaders.length, 3);
	assert.equal(validated.hostSupport.tools.nm, fixture.tools.nm);
	assert.equal(validated.outputByTarget.get('lldWasm').target, 'lldWasm');
	assert.equal(fixture.llvmReceipt.paths.sourceRoot, path.join(fixture.root, 'llvm-project'));

	const withoutLld = structuredClone(fixture.llvmReceipt);
	withoutLld.projects = ['clang'];
	assert.throws(
		() => validateLlvmWasiReceipt(withoutLld, { contract: fixture.contract }),
		/Clang\/libclang and LLD/u
	);
	const withoutLlvmC = structuredClone(fixture.llvmReceipt);
	withoutLlvmC.libclang.requiredHeaders =
		withoutLlvmC.libclang.requiredHeaders.filter(
			(header) => header.name !== 'llvm-c/Core.h'
		);
	assert.throws(
		() => validateLlvmWasiReceipt(withoutLlvmC, { contract: fixture.contract }),
		/exact Clang C API, LLVM C API/u
	);
	const stubsAllowed = structuredClone(fixture.llvmReceipt);
	stubsAllowed.hostSupportRequirements.archives[0].requiredSymbols = [];
	assert.throws(
		() => validateLlvmWasiReceipt(stubsAllowed, { contract: fixture.contract }),
		/six upstream C\+\+ translation units/u
	);
});

test('plans only the real upstream adapter with deterministic C++ host-support archives', async () => {
	const fixture = await createFixture();
	const receipt = await createBrowserCompilerBuildPlan(fixture.options, {
		contract: fixture.contract,
		verifySource: async () => fixture.sourceReceipt
	});
	assert.equal(receipt.status, 'dry-run');
	assert.equal(receipt.patch.path, 'patches/tinygo-wasi-adapter.patch');
	assert.equal(receipt.goLlvmSource.patch.path, 'patches/go-llvm-wasi-cgo-alias.patch');
	assert.equal(receipt.goToolchain.patch.path, 'patches/go-toolchain-wasip1-exec.patch');
	assert.equal(receipt.build.entrypoint.mode, 'upstream-compiler-adapter');
	assert.equal(receipt.build.hostCompileFallback, false);
	assert.deepEqual(
		receipt.compilerReceiptSeed.build.runtimeProfile,
		fixture.contract.manifest.compileProtocol.runtimeProfile
	);
	assert.deepEqual(
		receipt.compilerReceiptSeed.build.rootArchive,
		fixture.contract.manifest.rootArchive
	);
	assert.equal(
		receipt.build.packageGraph.filter(
			(packageName) => packageName === 'github.com/tinygo-org/tinygo/cgo'
		).length,
		1
	);
	assert.deepEqual(
		receipt.hostSupport.archives.map((archive) => archive.id),
		['tinygo-builder-cxx', 'go-llvm-cxx']
	);
	assert.equal(
		receipt.hostSupport.archives.flatMap((archive) => archive.compileCommands).length,
		6
	);
	assert.ok(
		receipt.hostSupport.archives
			.flatMap((archive) => archive.compileCommands)
			.every(
				(command) =>
					command[0] === fixture.tools.cxx &&
					command.includes('--target=wasm32-wasip1') &&
					command.includes('-std=c++17') &&
					command.includes('-fno-rtti')
			)
	);
	assert.ok(
		receipt.build.targetConfig.ldflags.includes(
			path.join(fixture.buildDir, 'host-support', 'libtinygo-builder-cxx.a')
		)
	);
	assert.ok(
		receipt.build.targetConfig.ldflags.includes(
			`-L${path.join(
				fixture.root,
				'wasi-sdk',
				'share',
				'wasi-sysroot',
				'lib',
				'wasm32-wasip1',
				'noeh'
			)}`
		)
	);
	assert.ok(
		receipt.build.targetConfig.ldflags.every(
			(argument) =>
				argument !== '--start-group' &&
				argument !== '--end-group' &&
				!argument.startsWith('--sysroot=')
		)
	);
	assert.ok(
		receipt.build.command.includes('./cmd/tinygo-browser-adapter')
	);
	assert.equal(receipt.build.targetConfig.scheduler, 'none');
	assert.equal(receipt.build.targetConfig['default-stack-size'], 8 * 1024 * 1024);
	assert.ok(receipt.build.command.some((argument) => argument.endsWith('tinygo-compiler.bc')));
	assert.ok(receipt.build.command.includes('-work'));
	assert.ok(receipt.build.command.includes('-interp-timeout=10m'));
	assert.equal(receipt.build.linkCommand[0], fixture.nativeWasmLd);
	assert.ok(receipt.build.linkCommand.includes('stack-size=8388608'));
	assert.deepEqual(
		receipt.hostSupport.compilerObjects.inputs.map((object) => object.id),
		['tinygo-runtime-stack', 'tinygo-libclang-abi']
	);
	assert.ok(
		receipt.hostSupport.compilerObjects.inputs.every((object) =>
			receipt.build.linkCommand.includes(object.path)
		)
	);
	assert.ok(
		receipt.build.targetConfig.ldflags.includes(
			path.join(fixture.buildDir, 'host-support', 'libc-no-dlmalloc.a')
		)
	);
	assert.ok(!receipt.build.command.includes('go'));
	assert.equal(receipt.goLlvmSource.files.length, 6);
	assert.match(receipt.llvm.compilerRtBuiltins.source.sha256, /^[0-9a-f]{64}$/u);
});

test('dry-run verifies the native TinyGo binary/root and writes no build artifacts', async () => {
	const fixture = await createFixture();
	const { calls, runner } = createCommandRunner(fixture);
	const receipt = await buildBrowserCompiler(fixture.options, {
		contract: fixture.contract,
		verifySource: async () => fixture.sourceReceipt,
		run: runner
	});
	assert.equal(receipt.status, 'dry-run');
	assert.equal(receipt.patch.status, 'applicable');
	assert.equal(receipt.hostSupport.status, 'planned');
	assert.equal(receipt.goLlvmSource.patch.status, 'applicable');
	assert.equal(receipt.goToolchain.archive.path, fixture.goToolchainArchive);
	assert.match(receipt.nativeLinker.version, /^LLD 21\.0\.0/u);
	assert.match(receipt.nativeTinyGo.version, /^tinygo version 0\.40\.1/u);
	assert.match(receipt.nativeTinyGo.binary.sha256, /^[0-9a-f]{64}$/u);
	assert.deepEqual(
		receipt.nativeTinyGo.rootIdentity.map((entry) => entry.path),
		NATIVE_ROOT_FILES
	);
	assert.deepEqual(
		receipt.nativeTinyGo.clangResource.headers.map((entry) => entry.name),
		['include/stddef.h', 'include/stdint.h']
	);
	assert.equal(calls.filter((call) => call.command === fixture.nativeTinyGo).length, 3);
	const rootCall = calls.find(
		(call) =>
			call.command === fixture.nativeTinyGo &&
			call.args[0] === 'env' &&
			call.args[1] === 'TINYGOROOT'
	);
	assert.equal(rootCall.runOptions.env.TINYGOROOT, fixture.nativeRoot);
	const wasmOptCall = calls.find(
		(call) =>
			call.command === fixture.nativeTinyGo &&
			call.args[0] === 'env' &&
			call.args[1] === 'WASMOPT'
	);
	assert.equal(wasmOptCall.runOptions.env.WASMOPT, fixture.wasmOpt);
	assert.equal(receipt.nativeTinyGo.binaryen.path, fixture.wasmOpt);
	assert.match(receipt.nativeTinyGo.binaryen.version, /wasm-opt version 123/u);
	assert.ok(!calls.some((call) => call.args[0] === 'build'));
	assert.deepEqual(JSON.parse(await readFile(fixture.receiptPath, 'utf8')), receipt);
	await assert.rejects(access(receipt.paths.patchedSourceRoot), /ENOENT/u);
	await assert.rejects(access(receipt.paths.patchedGoLlvmRoot), /ENOENT/u);
	await assert.rejects(access(receipt.paths.hostSupportDir), /ENOENT/u);
});

test('simulates upstream C++, runtime, libclang ABI objects, and the TinyGo build', async () => {
	const fixture = await createFixture();
	fixture.options.execute = true;
	const { calls, runner } = createCommandRunner(fixture, { execute: true });
	const receipt = await buildBrowserCompiler(fixture.options, {
		contract: fixture.contract,
		verifySource: async () => fixture.sourceReceipt,
		run: runner,
		copySource: copyPatchedSource
	});
	assert.equal(receipt.status, 'passed');
	assert.equal(receipt.patch.status, 'applied');
	assert.equal(receipt.goLlvmSource.patch.status, 'applied');
	assert.equal(receipt.goToolchain.patch.status, 'applied');
	assert.equal(receipt.hostSupport.status, 'passed');
	assert.equal(receipt.hostSupport.outputs.length, 2);
	assert.equal(receipt.hostSupport.compilerObjects.status, 'passed');
	assert.equal(receipt.hostSupport.compilerObjects.outputs.length, 2);
	await access(
		path.join(
			receipt.nativeTinyGo.clangResource.archivePath,
			'include/stddef.h'
		)
	);
	await access(
		path.join(receipt.llvm.compilerRtBuiltins.archivePath, 'absvdi2.c')
	);
	assert.equal(
		receipt.llvm.compilerRtBuiltins.archived.sha256,
		receipt.llvm.compilerRtBuiltins.source.sha256
	);
	assert.equal(receipt.hostSupport.toolEvidence.length, 4);
	assert.ok(
		receipt.llvm.wasiLibraries.every(
			(library) => library.bytes === 15 && /^[0-9a-f]{64}$/u.test(library.sha256)
		)
	);
	assert.equal(
		receipt.hostSupport.outputs.flatMap((output) => output.objects).length,
		6
	);
	assert.ok(
		receipt.hostSupport.outputs.every(
			(output) => output.bytes === 15 && /^[0-9a-f]{64}$/u.test(output.sha256)
		)
	);
	assert.equal(calls.filter((call) => call.command === fixture.tools.cxx).length, 8);
	assert.equal(calls.filter((call) => call.command === fixture.tools.ar).length, 5);
	assert.equal(calls.filter((call) => call.command === fixture.tools.ranlib).length, 3);
	assert.equal(calls.filter((call) => call.command === fixture.tools.nm).length, 2);
	const buildCall = calls.find(
		(call) =>
			call.command === fixture.nativeTinyGo &&
			call.args[0] === 'build' &&
			!call.args.includes('-x')
	);
	assert.equal(buildCall.runOptions.env.WASMOPT, fixture.wasmOpt);
	assert.equal(buildCall.runOptions.env.TINYGOROOT, receipt.paths.patchedSourceRoot);
	assert.equal(buildCall.runOptions.env.GOROOT, receipt.paths.goToolchainRoot);
	assert.equal(buildCall.runOptions.env.GOVERSION, 'go1.24.6');
	assert.equal(buildCall.runOptions.env.GOWORK, receipt.paths.goWorkPath);
	const linkCall = calls.find(
		(call) => call.command === fixture.nativeWasmLd && call.args[0] !== '--version'
	);
	assert.ok(linkCall.args.includes(receipt.paths.compilerBitcodePath));
	assert.ok(
		receipt.hostSupport.compilerObjects.outputs.every((object) =>
			linkCall.args.includes(object.path)
		)
	);
	assert.deepEqual(
		receipt.build.generatedEmbedObjects.outputs.map((output) => output.path),
		[
			path.join(
				receipt.paths.hostLinkInputDir,
				'embed-7ce70651d3f6149edd504627b500a7e5.o'
			)
		]
	);
	assert.ok(
		linkCall.args.includes(receipt.build.generatedEmbedObjects.outputs[0].path)
	);
	assert.ok(linkCall.args.includes('stack-size=8388608'));
	assert.deepEqual(receipt.build.imports, []);
	assert.ok(
		calls.every(
			(call) => !/^go(?:\.exe)?$/iu.test(path.basename(call.command))
		)
	);
	const targetConfig = JSON.parse(
		await readFile(receipt.paths.targetConfigPath, 'utf8')
	);
	assert.ok(targetConfig.ldflags.includes(receipt.hostSupport.outputs[0].path));
	assert.equal(targetConfig.scheduler, 'none');
	assert.match(receipt.hostSupport.filteredWasiLibc.sha256, /^[0-9a-f]{64}$/u);
	assert.equal(receipt.rootArchive.mergedGoRoot.status, 'passed');
	assert.deepEqual(
		receipt.rootArchive.mergedGoRoot.identity.map((entry) => entry.id),
		['tinygo-runtime', 'go-standard-library', 'go-environment']
	);
	assert.equal(receipt.rootArchive.runtimeClosure.status, 'passed');
	assert.equal(receipt.rootArchive.cgoHeaderClosure.status, 'passed');
	assert.equal(receipt.rootArchive.cgoHeaderClosure.clangResource.path, 'lib/clang');
	assert.equal(receipt.rootArchive.cgoHeaderClosure.wasiLibc.path, 'lib/wasi-libc/include');
	assert.equal(
		receipt.rootArchive.cgoHeaderClosure.libCxx.path,
		'lib/wasi-libc/include/c++/v1'
	);
	await access(
		path.join(receipt.paths.browserWasiLibcIncludeDir, 'stdio.h')
	);
	await access(path.join(receipt.paths.browserCxxIncludeDir, 'string'));
	assert.equal(
		receipt.rootArchive.runtimeClosure.manifest.value.compilerSha256,
		receipt.build.linkedCompiler.sha256
	);
	assert.deepEqual(
		[
			receipt.rootArchive.runtimeClosure.manifest.value.compilerRT,
			receipt.rootArchive.runtimeClosure.manifest.value.wasiLibc,
			receipt.rootArchive.runtimeClosure.manifest.value.libCxx,
			receipt.rootArchive.runtimeClosure.manifest.value.libCxxAbi,
			...Object.values(
				receipt.rootArchive.runtimeClosure.manifest.value.extraFiles
			)
		].map((asset) => asset.id),
		['compiler-rt', 'wasi-libc', 'libcxx', 'libcxxabi', 'extra-0', 'extra-1', 'extra-2']
	);
	assert.deepEqual(
		Object.values(
			receipt.rootArchive.runtimeClosure.manifest.value.extraFiles
		).map((asset) => [asset.path, asset.format]),
		[
			['runtime/wasip1-asyncify-precise-o1/extra-0.o', 'wasm-object'],
			['runtime/wasip1-asyncify-precise-o1/extra-1.bc', 'llvm-bitcode'],
			['runtime/wasip1-asyncify-precise-o1/extra-2.o', 'wasm-object']
		]
	);
	const tarCall = calls.find((call) => call.command === 'tar');
	assert.ok(tarCall.args.includes('--dereference'));
	assert.ok(tarCall.args.includes('src'));
	assert.ok(tarCall.args.includes('runtime'));
	assert.ok(tarCall.args.includes('lib/clang'));
	assert.ok(tarCall.args.includes('lib/wasi-libc/include'));
	assert.ok(!tarCall.args.includes('lib'));
	assert.equal(receipt.assets.length, 2);
	assert.ok(WebAssembly.validate(await readFile(receipt.paths.compilerPath)));
	assert.deepEqual(JSON.parse(await readFile(fixture.receiptPath, 'utf8')), receipt);
});

test('fails closed when TinyGo omits generated embed objects from the external link handoff', async () => {
	const fixture = await createFixture();
	fixture.options.execute = true;
	const { runner } = createCommandRunner(fixture, {
		execute: true,
		omitEmbedObject: true
	});
	await assert.rejects(
		buildBrowserCompiler(fixture.options, {
			contract: fixture.contract,
			verifySource: async () => fixture.sourceReceipt,
			run: runner,
			copySource: copyPatchedSource
		}),
		/did not retain its generated embed object inputs/u
	);
	assert.equal(
		JSON.parse(await readFile(fixture.receiptPath, 'utf8')).status,
		'failed'
	);
});

test('fails closed on bootstrap impersonation, go-llvm drift, and unsafe receipts', async () => {
	const badBootstrap = await createFixture();
	const badRunner = createCommandRunner(badBootstrap, { badVersion: true });
	await assert.rejects(
		buildBrowserCompiler(badBootstrap.options, {
			contract: badBootstrap.contract,
			verifySource: async () => badBootstrap.sourceReceipt,
			run: badRunner.runner
		}),
		/native compiler must be TinyGo 0\.40\.1 with LLVM 20/u
	);
	assert.equal(
		JSON.parse(await readFile(badBootstrap.receiptPath, 'utf8')).status,
		'failed'
	);

	const drifted = await createFixture();
	await writeFile(
		path.join(drifted.goLlvmSourceRoot, 'IRBindings.cpp'),
		'drifted\n'
	);
	await assert.rejects(
		createBrowserCompilerBuildPlan(drifted.options, {
			contract: drifted.contract,
			verifySource: async () => drifted.sourceReceipt
		}),
		/differs from locked go-llvm/u
	);

	const unsafe = await createFixture();
	const unsafeReceipt = path.join(unsafe.sourceRoot, 'build-receipt.json');
	await assert.rejects(
		buildBrowserCompiler(
			{ ...unsafe.options, receiptPath: unsafeReceipt },
			{
				contract: unsafe.contract,
				verifySource: async () => unsafe.sourceReceipt,
				run: createCommandRunner(unsafe).runner
			}
		),
		/--receipt must be outside/u
	);
	await assert.rejects(access(unsafeReceipt), /ENOENT/u);

	const unsafeNative = await createFixture();
	const nativeReceipt = path.join(
		unsafeNative.nativeRoot,
		'build-receipt.json'
	);
	await assert.rejects(
		buildBrowserCompiler(
			{ ...unsafeNative.options, receiptPath: nativeReceipt },
			{
				contract: unsafeNative.contract,
				verifySource: async () => unsafeNative.sourceReceipt,
				run: createCommandRunner(unsafeNative).runner
			}
		),
		/--receipt must be outside/u
	);
	await assert.rejects(access(nativeReceipt), /ENOENT/u);
});

test('validates static archives and wasm32 relocatable object magic', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'wasm-llvm-tinygo-build-file-'));
	tempDirs.push(root);
	const archivePath = path.join(root, 'support.a');
	const objectPath = path.join(root, 'support.o');
	await writeFile(archivePath, Buffer.from('!<arch>\nfixture'));
	await writeFile(objectPath, WASM_HEADER);
	assert.equal((await inspectBuildFile(archivePath, { staticArchive: true })).bytes, 15);
	assert.equal((await inspectBuildFile(objectPath, { wasmObject: true })).bytes, 8);
	await writeFile(objectPath, 'native object');
	await assert.rejects(
		inspectBuildFile(objectPath, { wasmObject: true }),
		/not a WebAssembly relocatable object/u
	);
});
