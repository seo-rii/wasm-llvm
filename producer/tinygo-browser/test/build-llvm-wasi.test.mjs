import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
	buildTinyGoLlvmWasi,
	createTinyGoLlvmWasiBuildPlan,
	createTinyGoLlvmWasiToolchain,
	inspectLlvmHeader,
	inspectLlvmStaticArchive,
	parseBuildLlvmWasiArgs
} from '../scripts/build-llvm-wasi.mjs';

const tempDirs = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

async function createOptions(extra = []) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'wasm-llvm-tinygo-llvm-wasi-'));
	tempDirs.push(root);
	return {
		root,
		options: parseBuildLlvmWasiArgs([
			'--source-root',
			path.join(root, 'llvm-project'),
			'--wasi-sdk',
			path.join(root, 'wasi-sdk'),
			'--native-tool-dir',
			path.join(root, 'native', 'bin'),
			'--build-dir',
			path.join(root, 'build'),
			'--receipt',
			path.join(root, 'receipt.json'),
			'--jobs',
			'2',
			...extra
		])
	};
}

async function createExecuteInputs(options) {
	const files = [
		path.join(options.sourceRoot, 'llvm', 'CMakeLists.txt'),
		path.join(options.wasiSdk, 'bin', 'clang'),
		path.join(options.wasiSdk, 'bin', 'clang++'),
		path.join(options.wasiSdk, 'bin', 'llvm-ar'),
		path.join(options.wasiSdk, 'bin', 'llvm-ranlib'),
		path.join(options.wasiSdk, 'bin', 'llvm-nm'),
		path.join(options.nativeToolDir, 'llvm-tblgen'),
		path.join(options.nativeToolDir, 'clang-tblgen'),
		path.join(options.sourceRoot, 'clang', 'include', 'clang-c', 'Index.h'),
		path.join(options.sourceRoot, 'llvm', 'include', 'llvm-c', 'Core.h')
	];
	await Promise.all(
		files.map(async (filePath) => {
			await mkdir(path.dirname(filePath), { recursive: true });
			await writeFile(filePath, 'fixture');
		})
	);
	await mkdir(path.join(options.wasiSdk, 'share', 'wasi-sysroot'), { recursive: true });
}

async function writeUpstreamPatchFixture(plan, args) {
	const outputArgument = args.find((argument) => argument.startsWith('--output='));
	assert.ok(outputArgument);
	const patchSource = plan.upstreamPatch.expectedPaths
		.map((patchedPath) => `diff --git a/${patchedPath} b/${patchedPath}\n`)
		.join('');
	await writeFile(outputArgument.slice('--output='.length), patchSource);
}

test('parses dry-run, patch-check, and execute options without allowing mixed modes', async () => {
	const { options } = await createOptions(['--execute', '--configure-only']);
	assert.equal(options.execute, true);
	assert.equal(options.configureOnly, true);
	assert.equal(options.jobs, 2);
	assert.deepEqual(parseBuildLlvmWasiArgs(['--help']), { help: true });
	assert.throws(() => parseBuildLlvmWasiArgs([]), /--source-root is required/u);
	assert.throws(
		() =>
			parseBuildLlvmWasiArgs([
				'--source-root',
				'src',
				'--wasi-sdk',
				'sdk',
				'--native-tool-dir',
				'native',
				'--jobs',
				'0'
			]),
		/positive integer/u
	);
	assert.throws(
		() =>
			parseBuildLlvmWasiArgs([
				'--source-root',
				'src',
				'--wasi-sdk',
				'sdk',
				'--native-tool-dir',
				'native',
				'--check-patch',
				'--execute'
			]),
		/mutually exclusive/u
	);
	assert.throws(
		() =>
			parseBuildLlvmWasiArgs([
				'--source-root',
				'src',
				'--wasi-sdk',
				'sdk',
				'--native-tool-dir',
				'native',
				'--configure-only'
			]),
		/requires --execute/u
	);
});

test('creates a WebAssembly-only static Clang, LLD, and LLVM plan pinned to TinyGo LLVM 20.1.1', async () => {
	const { options } = await createOptions();
	const plan = await createTinyGoLlvmWasiBuildPlan(options);
	assert.equal(plan.source.commit, '670759811adc85df52f410d7306788fabfc6242d');
	assert.equal(plan.source.version, '20.1.1');
	assert.equal(plan.host.compilerTarget, 'wasm32-wasip1');
	assert.deepEqual(plan.host.targetsToBuild, ['WebAssembly']);
	assert.deepEqual(plan.projects, ['clang', 'lld']);
	assert.equal(plan.archiveTargets[0], 'libclang');
	assert.ok(plan.archiveTargets.includes('clangDriver'));
	assert.ok(plan.archiveTargets.includes('lldWasm'));
	assert.ok(plan.archiveTargets.includes('LLVMCore'));
	assert.ok(plan.archiveTargets.includes('LLVMSupport'));
	assert.ok(plan.archiveTargets.includes('LLVMWebAssemblyCodeGen'));
	assert.ok(plan.archiveTargets.includes('LLVMExecutionEngine'));
	assert.equal(plan.expectedArchives.length, plan.archiveTargets.length);
	assert.ok(plan.configureCommand.includes('-DLLVM_ENABLE_PROJECTS=clang;lld'));
	assert.ok(plan.configureCommand.includes('-DLLVM_ENABLE_THREADS=OFF'));
	assert.ok(plan.configureCommand.includes('-DLLVM_BUILD_TOOLS=OFF'));
	assert.ok(plan.configureCommand.includes('-DLIBCLANG_BUILD_STATIC=ON'));
	assert.ok(
		plan.configureCommand.includes(
			`-DLLVM_TABLEGEN=${path.join(options.nativeToolDir, 'llvm-tblgen')}`
		)
	);
	assert.ok(
		plan.configureCommand.includes(
			`-DCLANG_TABLEGEN=${path.join(options.nativeToolDir, 'clang-tblgen')}`
		)
	);
	assert.equal(plan.libclang.target, 'libclang');
	assert.equal(
		plan.libclang.archivePath,
		path.join(options.buildDir, 'llvm', 'lib', 'libclang.a')
	);
	assert.deepEqual(
		plan.libclang.requiredHeaders.map((header) => header.name),
		['clang-c/Index.h', 'llvm-c/Core.h', 'llvm/Config/llvm-config.h']
	);
	assert.deepEqual(plan.hostSupportRequirements.tools, {
		cxx: path.join(options.wasiSdk, 'bin', 'clang++'),
		ar: path.join(options.wasiSdk, 'bin', 'llvm-ar'),
		ranlib: path.join(options.wasiSdk, 'bin', 'llvm-ranlib'),
		nm: path.join(options.wasiSdk, 'bin', 'llvm-nm')
	});
	assert.deepEqual(
		plan.hostSupportRequirements.archives.map((archive) => archive.id),
		['tinygo-builder-cxx', 'go-llvm-cxx']
	);
	assert.deepEqual(
		plan.hostSupportRequirements.archives.flatMap(
			(archive) => archive.requiredSymbols
		),
		[
			'tinygo_clang_driver',
			'tinygo_link',
			'tinygo_validate_wasm_object',
			'LLVMConstantAsMetadata',
			'LLVMLoadLibraryPermanently2',
			'LLVMGoWriteThinLTOBitcodeToMemoryBuffer'
		]
	);
	assert.equal(plan.hostSupportRequirements.includeRoots.length, 6);
	assert.ok(plan.hostSupportRequirements.definitions.includes('CINDEX_NO_EXPORTS'));
	assert.deepEqual(
		plan.hostSupportRequirements.staticLinkArchiveTargets,
		plan.archiveTargets
	);
	assert.equal(plan.hostSupportRequirements.compilerRuntime, null);
	assert.deepEqual(plan.requiredFinalLinkLibraries.slice(-2), ['c++', 'c++abi']);
	assert.ok(plan.requiredFinalLinkLibraries.includes('dl'));
	assert.match(plan.inputs.configSha256, /^[0-9a-f]{64}$/u);
	assert.match(plan.inputs.sourcesLockSha256, /^[0-9a-f]{64}$/u);
	assert.match(plan.inputs.patchSha256, /^[0-9a-f]{64}$/u);
});

test('binds the LLVM platform patch to the shared TinyGo sources lock', async () => {
	const { root, options } = await createOptions();
	const producerRoot = path.join(root, 'producer');
	const files = [
		['config/llvm-wasi-static.json', '../config/llvm-wasi-static.json'],
		['patches/llvm-wasi-c-api-config.patch', '../patches/llvm-wasi-c-api-config.patch'],
		['scripts/build-llvm-wasi.mjs', '../scripts/build-llvm-wasi.mjs']
	];
	await Promise.all(
		files.map(async ([relativePath, source]) => {
			const destination = path.join(producerRoot, relativePath);
			await mkdir(path.dirname(destination), { recursive: true });
			await writeFile(destination, await readFile(new URL(source, import.meta.url)));
		})
	);
	const sourcesLock = JSON.parse(
		await readFile(new URL('../sources.lock.json', import.meta.url), 'utf8')
	);
	sourcesLock.patches.find(
		(entry) => entry.path === 'patches/llvm-wasi-c-api-config.patch'
	).sha256 = '0'.repeat(64);
	await writeFile(
		path.join(producerRoot, 'sources.lock.json'),
		`${JSON.stringify(sourcesLock, null, 2)}\n`
	);
	await assert.rejects(
		createTinyGoLlvmWasiBuildPlan(options, { producerRoot }),
		/LLVM WASI patch checksum mismatch/u
	);
});

test('generates a no-thread wasm32-wasip1 CMake toolchain without executable probes', async () => {
	const { options } = await createOptions();
	const plan = await createTinyGoLlvmWasiBuildPlan(options);
	const config = JSON.parse(
		await readFile(new URL('../config/llvm-wasi-static.json', import.meta.url), 'utf8')
	);
	const source = createTinyGoLlvmWasiToolchain({ wasiSdk: options.wasiSdk, config });
	assert.equal(source, plan.toolchainSource);
	assert.match(source, /set\(CMAKE_SYSTEM_NAME WASI\)/u);
	assert.match(source, /set\(CMAKE_CXX_COMPILER_TARGET "wasm32-wasip1"\)/u);
	assert.match(source, /set\(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY\)/u);
	assert.match(source, /-D_WASI_EMULATED_MMAN/u);
	assert.match(source, /-stdlib=libc\+\+ -fno-exceptions -fno-rtti/u);
	assert.doesNotMatch(source, /wasm-ld|CMAKE_EXE_LINKER_FLAGS/u);
});

test('writes a deterministic dry-run receipt without running Git, CMake, or Ninja', async () => {
	const { options } = await createOptions();
	const receipt = await buildTinyGoLlvmWasi(options, {
		run: async () => {
			throw new Error('dry run must not execute commands');
		}
	});
	assert.equal(receipt.status, 'dry-run');
	assert.equal(receipt.patchStatus, 'pending');
	assert.equal(receipt.outputs, null);
	assert.equal(receipt.errorMessage, null);
	assert.ok(!('toolchainSource' in receipt));
	assert.deepEqual(JSON.parse(await readFile(options.receiptPath, 'utf8')), receipt);
	assert.match(
		await readFile(receipt.paths.toolchainPath, 'utf8'),
		/CMAKE_C_COMPILER_TARGET "wasm32-wasip1"/u
	);
});

test('checks exact source revision and patch applicability without modifying the checkout', async () => {
	const { options } = await createOptions(['--check-patch']);
	await mkdir(path.join(options.sourceRoot, '.git'), { recursive: true });
	await writeFile(path.join(options.sourceRoot, '.git', 'index'), 'fixture-index');
	const plan = await createTinyGoLlvmWasiBuildPlan(options);
	const calls = [];
	const receipt = await buildTinyGoLlvmWasi(options, {
			run: async (command, args, runOptions = {}) => {
			calls.push({ command, args, runOptions });
			if (args[0] === 'rev-parse') {
				if (args[1] === '--git-path') {
					return {
						exitCode: 0,
						signal: null,
						stdout: '.git/index\n',
						stderr: ''
					};
				}
				return {
					exitCode: 0,
					signal: null,
					stdout: '670759811adc85df52f410d7306788fabfc6242d\n',
					stderr: ''
				};
			}
			if (args[0] === 'show') {
				return {
					exitCode: 0,
					signal: null,
					stdout: `${plan.upstreamPatch.parent}\n`,
					stderr: ''
				};
			}
			if (args[0] === 'diff') await writeUpstreamPatchFixture(plan, args);
			if (args[0] === 'apply' && args.includes('--reverse')) {
				return { exitCode: 1, signal: null, stdout: '', stderr: 'not applied' };
			}
			return { exitCode: 0, signal: null, stdout: '', stderr: '' };
		}
	});
	assert.equal(receipt.status, 'patch-checked');
	assert.equal(receipt.upstreamPatchStatus, 'applicable');
	assert.equal(receipt.patchStatus, 'applicable');
	assert.equal(calls.length, 10);
	assert.deepEqual(calls[0].args, ['rev-parse', 'HEAD']);
	assert.deepEqual(calls[1].args.slice(0, 3), ['fetch', '--depth', '2']);
	assert.deepEqual(calls[2].args.slice(0, 3), ['show', '-s', '--format=%P']);
	assert.equal(calls[3].args[0], 'diff');
	assert.ok(calls.slice(4).every((call) => call.args[0] === 'apply' || call.args[0] === 'rev-parse'));
	assert.ok(
		calls.some(
			(call) =>
				call.runOptions.env?.GIT_INDEX_FILE?.endsWith('patch-check.index') &&
				call.args.includes('--cached')
		)
	);
	assert.ok(calls.every((call) => call.command === 'git'));
});

test('simulates patching, configuring, and building every receipt-bound static archive', async () => {
	const { options } = await createOptions(['--execute']);
	await createExecuteInputs(options);
	const plan = await createTinyGoLlvmWasiBuildPlan(options);
	const compilerRuntimePath = path.join(
		options.wasiSdk,
		'lib',
		'clang',
		'fixture',
		'libclang_rt.builtins.a'
	);
	const calls = [];
	const receipt = await buildTinyGoLlvmWasi(options, {
		run: async (command, args, runOptions = {}) => {
			calls.push({ command, args, runOptions });
			if (command === 'git' && args[0] === 'rev-parse') {
				return {
					exitCode: 0,
					signal: null,
					stdout: `${plan.source.commit}\n`,
					stderr: ''
				};
			}
			if (command === 'git' && args[0] === 'show') {
				return {
					exitCode: 0,
					signal: null,
					stdout: `${plan.upstreamPatch.parent}\n`,
					stderr: ''
				};
			}
			if (command === 'git' && args[0] === 'diff') {
				await writeUpstreamPatchFixture(plan, args);
			}
				if (command === 'git' && args.includes('--reverse')) {
				return { exitCode: 1, signal: null, stdout: '', stderr: 'not applied' };
				}
				if (command === plan.hostSupportRequirements.tools.cxx) {
					await mkdir(path.dirname(compilerRuntimePath), { recursive: true });
					await writeFile(compilerRuntimePath, Buffer.from('!<arch>\nfixture'));
					return {
						exitCode: 0,
						signal: null,
						stdout: `${compilerRuntimePath}\n`,
						stderr: ''
					};
				}
				if (
					command === plan.hostSupportRequirements.tools.nm &&
					args.includes(compilerRuntimePath)
				) {
					return {
						exitCode: 0,
						signal: null,
						stdout: '00000001 T __multi3\n00000001 T __udivti3\n',
						stderr: ''
					};
				}
			if (command === 'cmake' && args[0] === '--build') {
				await Promise.all(
					plan.expectedArchives.map(async (archive) => {
						await mkdir(path.dirname(archive.path), { recursive: true });
						await writeFile(archive.path, Buffer.from('!<arch>\nfixture'));
					})
				);
				const generatedHeader = plan.libclang.requiredHeaders.find(
					(header) => header.name === 'llvm/Config/llvm-config.h'
				).path;
				await mkdir(path.dirname(generatedHeader), { recursive: true });
				await writeFile(generatedHeader, '#define LLVM_VERSION_MAJOR 20\n');
			}
			return { exitCode: 0, signal: null, stdout: '', stderr: '' };
		}
	});
	assert.equal(receipt.status, 'passed');
	assert.equal(receipt.upstreamPatchStatus, 'applied');
	assert.equal(receipt.patchStatus, 'applied');
	assert.match(receipt.upstreamPatchEvidence.sha256, /^[0-9a-f]{64}$/u);
	assert.equal(receipt.outputs.length, receipt.archiveTargets.length);
	assert.ok(receipt.outputs.every((output) => output.bytes === 15));
	assert.equal(receipt.libclangEvidence.archive.target, 'libclang');
	assert.equal(receipt.hostSupportRequirements.compilerRuntime.path, compilerRuntimePath);
	assert.deepEqual(
		receipt.hostSupportRequirements.compilerRuntime.requiredSymbols,
		['__multi3', '__udivti3']
	);
	assert.deepEqual(
		receipt.libclangEvidence.headers.map((header) => header.name),
		['clang-c/Index.h', 'llvm-c/Core.h', 'llvm/Config/llvm-config.h']
	);
	assert.equal(calls.filter((call) => call.command === 'cmake').length, 2);
	assert.ok(calls.some((call) => call.command === 'git' && call.args[0] === 'apply' && call.args.length === 2));
	assert.deepEqual(
		receipt.outputs.map((output) => output.path),
		receipt.expectedArchives.map((output) => output.path)
	);
});

test('fails closed and writes a receipt for a checkout at the wrong LLVM commit', async () => {
	const { options } = await createOptions(['--check-patch']);
	await assert.rejects(
		buildTinyGoLlvmWasi(options, {
			run: async () => ({
				exitCode: 0,
				signal: null,
				stdout: `${'0'.repeat(40)}\n`,
				stderr: ''
			})
		}),
		/source commit mismatch/u
	);
	const receipt = JSON.parse(await readFile(options.receiptPath, 'utf8'));
	assert.equal(receipt.status, 'failed');
	assert.match(receipt.errorMessage, /source commit mismatch/u);
});

test('validates static archive magic and hashes archive contents', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'wasm-llvm-tinygo-archive-'));
	tempDirs.push(root);
	const archivePath = path.join(root, 'libLLVMCore.a');
	await writeFile(archivePath, Buffer.from('!<arch>\nfixture'));
	const inspected = await inspectLlvmStaticArchive(archivePath);
	assert.equal(inspected.bytes, 15);
	assert.match(inspected.sha256, /^[0-9a-f]{64}$/u);
	await writeFile(archivePath, 'not archive');
	await assert.rejects(inspectLlvmStaticArchive(archivePath), /not a static archive/u);
});

test('hashes non-empty source and generated header evidence', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'wasm-llvm-tinygo-header-'));
	tempDirs.push(root);
	const headerPath = path.join(root, 'llvm-config.h');
	await writeFile(headerPath, '#define LLVM_VERSION_MAJOR 20\n');
	const inspected = await inspectLlvmHeader(headerPath);
	assert.equal(inspected.bytes, 30);
	assert.match(inspected.sha256, /^[0-9a-f]{64}$/u);
	await writeFile(headerPath, '');
	await assert.rejects(inspectLlvmHeader(headerPath), /not a non-empty header/u);
});

test('keeps the TinyGo port patch to WASI host compatibility without compiler substitutes', async () => {
	const patch = await readFile(
		new URL('../patches/llvm-wasi-c-api-config.patch', import.meta.url),
		'utf8'
	);
	const paths = [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gmu)].map(
		(match) => match[1]
	);
	assert.deepEqual(paths, [
		'clang/include/clang/Support/Compiler.h',
		'clang/tools/libclang/CIndexer.cpp',
		'llvm/cmake/config-ix.cmake',
		'llvm/include/llvm/Support/Compiler.h',
		'llvm/lib/Support/CrashRecoveryContext.cpp',
		'llvm/lib/Support/Signals.cpp',
		'llvm/lib/Support/Unix/Process.inc',
		'llvm/lib/Support/Unix/Program.inc'
	]);
	assert.match(patch, /CMAKE_SYSTEM_NAME STREQUAL "WASI"/u);
	assert.match(patch, /defined\(__wasi__\)/u);
	assert.match(patch, /#include "llvm\/Config\/config\.h"/u);
	assert.match(patch, /HAVE_SETJMP/u);
	assert.match(patch, /void Process::PreventCoreFiles\(\)/u);
	assert.match(patch, /static void SetMemoryLimits\(unsigned size\)/u);
	assert.match(patch, /WASI does not support waiting for subprocesses/u);
	assert.match(patch, /static bool printMarkupContext\(raw_ostream &, const char \*\)/u);
	assert.match(patch, /void llvm::sys::PrintStackTrace\(raw_ostream &OS, int Depth\)/u);
	assert.match(patch, /static const int page_size = 65536/u);
	assert.match(patch, /size_t Process::GetMallocUsage\(\)/u);
	assert.doesNotMatch(patch, /setSwitchedThread|ThreadPoolFuture|cc1depscan/u);
	assert.doesNotMatch(patch, /^diff --git a\/(?:clang\/lib|lld)\//mu);
});
