#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GCC_COMPATIBILITY_HEADERS } from './gcc-compat.mjs';
import { buildMemfs } from './build-memfs.mjs';
import { pruneSysrootHeaders, SYSROOT_C_PROBE, SYSROOT_CPP_PROBE } from './sysroot-pruning.mjs';
import { createClangdHeaderAsset, prepareClangdHeaders } from './prepare-clangd-headers.mjs';
import { clangdResourceProfile } from './resource-profile.mjs';
import { addWasiSignalStub, assertDirectoryUnchanged, assertFileUnchanged, claimFreshBuildDirectory, directoryIdentity, downloadPinned, emsdkShellCommand, extractPinnedArchive, fileIdentity, pinnedCommitPatch, verifyPatchedCheckout } from './build-provenance.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const producerRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(producerRoot, '..', '..');
const producerManifestPath = path.join(producerRoot, 'manifest.json');
const producerManifestBytes = await fs.readFile(producerManifestPath);
const producerManifestIdentity = { bytes: producerManifestBytes.length, sha256: createHash('sha256').update(producerManifestBytes).digest('hex') };
const producerManifest = JSON.parse(producerManifestBytes);
const llvmBuildType = process.env.LLVM_BUILD_TYPE || 'MinSizeRel';
const targetProfile = process.env.CLANG_TARGET_PROFILE || 'wasm32-wasi';
if (!['wasm32-wasi', 'x86_64-linux-gnu'].includes(targetProfile)) {
	throw new Error('CLANG_TARGET_PROFILE must be wasm32-wasi or x86_64-linux-gnu');
}
const crossProfile = targetProfile === 'x86_64-linux-gnu'
	? JSON.parse(await fs.readFile(path.join(producerRoot, 'cross/profile.json'), 'utf8'))
	: null;
const lldPatch = crossProfile?.lldPatch || producerManifest.sources.lldWasmOnlyPatch;
// Libraries that dominate parsing, semantic analysis and code generation time when the WASI
// compiler builds typical single-file programs. Relative to the LLVM checkout.
const defaultHotPathDirs = ['clang/lib/Lex', 'clang/lib/Basic', 'llvm/lib/Support'];

const config = {
	llvmVersion: process.env.LLVM_VERSION || producerManifest.sources.llvm.version,
	llvmCommit:
		process.env.LLVM_COMMIT ||
		(process.env.LLVM_VERSION ? '' : producerManifest.sources.llvm.commit),
	wasiSdkVersion: process.env.WASI_SDK_VERSION || producerManifest.toolchains.wasiSdk.version,
	emsdkVersion: process.env.EMSDK_VERSION || producerManifest.toolchains.emsdk.version,
	emsdkCommit:
		process.env.EMSDK_COMMIT ||
		(process.env.EMSDK_VERSION ? '' : producerManifest.toolchains.emsdk.commit),
	targetTriple: process.env.TARGET_TRIPLE || crossProfile?.target || 'wasm32-wasi',
	hostTriple: process.env.HOST_TRIPLE || 'wasm32-wasip1',
	yowaspWasiPatchRepo:
		process.env.YOWASP_WASI_PATCH_REPO || producerManifest.sources.wasiHostPatch.repository,
	yowaspWasiPatchCommit:
		process.env.YOWASP_WASI_PATCH_COMMIT || producerManifest.sources.wasiHostPatch.commit,
	llvmBuildType,
	llvmMinSizeOpt: process.env.LLVM_MINSIZE_OPT || 'Oz',
	llvmHotPathOpt: process.env.LLVM_HOT_PATH_OPT || 'none',
	llvmHotPathDirs: (process.env.LLVM_HOT_PATH_DIRS || defaultHotPathDirs.join(','))
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean),
	clangWasmOpt: process.env.CLANG_WASM_OPT || 'default',
	clangToolHost: process.env.CLANG_TOOL_HOST || (crossProfile ? 'ON' : 'OFF'),
	clangdLto: process.env.CLANGD_LTO || 'ON',
	clangdAssertions: process.env.CLANGD_ASSERTIONS || (llvmBuildType === 'Debug' ? 'ON' : 'OFF'),
	clangdTidyChecks: process.env.CLANGD_TIDY_CHECKS || 'OFF',
	clangdDecisionForest: process.env.CLANGD_DECISION_FOREST || 'OFF',
	clangdSeparateHeaders: process.env.CLANGD_SEPARATE_HEADERS || 'OFF',
	clangdResources: clangdResourceProfile(),
	workDir: path.resolve(
		process.env.WASM_LLVM_TOOLCHAIN_WORK_DIR ||
			process.env.WASM_CLANG_TOOLCHAIN_WORK_DIR ||
			path.join(repoRoot, 'artifacts', 'toolchain-build')
	),
	outDir: path.resolve(
		process.env.WASM_LLVM_TOOLCHAIN_OUT_DIR ||
			process.env.WASM_CLANG_TOOLCHAIN_OUT_DIR ||
			path.join(repoRoot, 'artifacts', 'clang-browser')
	),
	ninjaJobs: process.env.NINJA_JOBS || ''
};
const tempDir = path.resolve(process.env.TMPDIR || path.join(config.workDir, 'tmp'));
process.env.TMPDIR = tempDir;

for (const [name, value] of [
	['CLANG_TOOL_HOST', config.clangToolHost],
	['CLANGD_LTO', config.clangdLto],
	['CLANGD_ASSERTIONS', config.clangdAssertions],
	['CLANGD_TIDY_CHECKS', config.clangdTidyChecks],
	['CLANGD_DECISION_FOREST', config.clangdDecisionForest],
	['CLANGD_SEPARATE_HEADERS', config.clangdSeparateHeaders]
]) {
	if (!['ON', 'OFF'].includes(value)) throw new Error(`${name} must be ON or OFF`);
}
if (!['Os', 'Oz'].includes(config.llvmMinSizeOpt)) {
	throw new Error('LLVM_MINSIZE_OPT must be Os or Oz');
}
if (!['none', 'O2', 'O3'].includes(config.llvmHotPathOpt)) {
	throw new Error('LLVM_HOT_PATH_OPT must be none, O2 or O3');
}
if (config.llvmHotPathOpt !== 'none' && config.llvmBuildType !== 'MinSizeRel') {
	throw new Error('LLVM_HOT_PATH_OPT requires LLVM_BUILD_TYPE=MinSizeRel');
}
for (const dir of config.llvmHotPathDirs) {
	if (path.isAbsolute(dir) || dir.split('/').includes('..') || dir.includes(':')) {
		throw new Error(`LLVM_HOT_PATH_DIRS entries must be relative LLVM checkout paths: ${dir}`);
	}
}
if (!['default', 'O2', 'O3'].includes(config.clangWasmOpt)) {
	throw new Error('CLANG_WASM_OPT must be default, O2 or O3');
}

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const compilerOnly = args.includes('--compiler-only');
if (args.includes('--help') || args.includes('-h')) {
	console.log(`Usage: pnpm build:clang [-- --compiler-only]

Environment:
  LLVM_VERSION=${config.llvmVersion}
  LLVM_COMMIT=${config.llvmCommit || '<required with LLVM_VERSION>'}
  WASI_SDK_VERSION=${config.wasiSdkVersion}
  EMSDK_VERSION=${config.emsdkVersion}
  EMSDK_COMMIT=${config.emsdkCommit || '<required with EMSDK_VERSION>'}
  TARGET_TRIPLE=${config.targetTriple}
  HOST_TRIPLE=${config.hostTriple}
  CLANG_TARGET_PROFILE=${targetProfile} (x86_64-linux-gnu requires --compiler-only; exports a separate native cross bundle)
  LLVM_BUILD_TYPE=${config.llvmBuildType}
  LLVM_MINSIZE_OPT=${config.llvmMinSizeOpt}
  LLVM_HOT_PATH_OPT=${config.llvmHotPathOpt}
  LLVM_HOT_PATH_DIRS=${config.llvmHotPathDirs.join(',')}
  CLANG_WASM_OPT=${config.clangWasmOpt}
  CLANG_TOOL_HOST=${config.clangToolHost} (experimental; requires --compiler-only and fresh explicit directories)
  CLANGD_LTO=${config.clangdLto}
  CLANGD_ASSERTIONS=${config.clangdAssertions}
  CLANGD_TIDY_CHECKS=${config.clangdTidyChecks}
  CLANGD_DECISION_FOREST=${config.clangdDecisionForest}
  CLANGD_SEPARATE_HEADERS=${config.clangdSeparateHeaders}
  CLANGD_INITIAL_MEMORY_MIB=${config.clangdResources.initialMemoryMiB} (experimental)
  CLANGD_PTHREAD_POOL_SIZE=${config.clangdResources.pthreadPoolSize} (unset preserves hardware-based default)
  YOWASP_WASI_PATCH_REPO=${config.yowaspWasiPatchRepo}
  YOWASP_WASI_PATCH_COMMIT=${config.yowaspWasiPatchCommit}
  WASM_LLVM_TOOLCHAIN_WORK_DIR=${config.workDir}
  WASM_LLVM_TOOLCHAIN_OUT_DIR=${config.outDir}
  TMPDIR=${tempDir}
  NINJA_JOBS=<optional ninja parallelism>

This is a large build. It builds raw WASI clang/wasm-ld and an Emscripten pthread clangd,
then calls package-toolchain.mjs to refresh artifacts/clang-browser. --compiler-only stops after
the WASI clang/wasm-ld modules and writes them with compiler-build.json to
WASM_LLVM_TOOLCHAIN_OUT_DIR/compiler for benchmark-compiler.mjs.`);
	process.exit(0);
}

let toolHostProfile = null;
if (crossProfile && (!compilerOnly || config.clangToolHost !== 'ON' ||
	config.targetTriple !== crossProfile.target || config.hostTriple !== crossProfile.host)) {
	throw new Error('The x86_64-linux-gnu profile requires --compiler-only, CLANG_TOOL_HOST=ON, its fixed target and wasm32-wasip1 host');
}
if (config.clangToolHost === 'ON') {
	if (!compilerOnly) throw new Error('CLANG_TOOL_HOST requires --compiler-only; release packaging is not qualified');
	if (!process.env.WASM_LLVM_TOOLCHAIN_WORK_DIR || !process.env.WASM_LLVM_TOOLCHAIN_OUT_DIR) {
		throw new Error('CLANG_TOOL_HOST requires explicit WASM_LLVM_TOOLCHAIN_WORK_DIR and WASM_LLVM_TOOLCHAIN_OUT_DIR');
	}
	const contains = (parent, child) => {
		const relative = path.relative(parent, child);
		return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
	};
	if (contains(config.workDir, config.outDir) || contains(config.outDir, config.workDir)) {
		throw new Error('CLANG_TOOL_HOST work/output directories must be separate');
	}
	for (const directory of [config.workDir, config.outDir]) {
		try {
			await fs.lstat(directory);
			throw new Error(`CLANG_TOOL_HOST requires a fresh directory: ${directory}`);
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}
	toolHostProfile = JSON.parse(await fs.readFile(path.join(producerRoot, 'tool-host/profile.json'), 'utf8'));
	if (config.llvmCommit !== toolHostProfile.llvmCommit || config.hostTriple !== 'wasm32-wasip1') {
		throw new Error('CLANG_TOOL_HOST requires the profile-pinned LLVM revision and wasm32-wasip1 host');
	}
	// The tool-host receipt records the manifest's sources and SDK pins; caller overrides would
	// build from different inputs (or an unverified WASI_SDK_PATH) under that same identity.
	const overridden = [
		['LLVM_VERSION', config.llvmVersion, producerManifest.sources.llvm.version],
		['YOWASP_WASI_PATCH_REPO', config.yowaspWasiPatchRepo, producerManifest.sources.wasiHostPatch.repository],
		['YOWASP_WASI_PATCH_COMMIT', config.yowaspWasiPatchCommit, producerManifest.sources.wasiHostPatch.commit],
		['WASI_SDK_VERSION', config.wasiSdkVersion, producerManifest.toolchains.wasiSdk.version],
		['EMSDK_VERSION', config.emsdkVersion, producerManifest.toolchains.emsdk.version],
		['EMSDK_COMMIT', config.emsdkCommit, producerManifest.toolchains.emsdk.commit],
		['TARGET_TRIPLE', config.targetTriple, crossProfile?.target || producerManifest.target]
	]
		.filter(([, actual, expected]) => actual !== expected)
		.map(([name]) => name);
	if (process.env.WASI_SDK_PATH) overridden.push('WASI_SDK_PATH');
	if (overridden.length) {
		throw new Error(`CLANG_TOOL_HOST requires producer-manifest pinned inputs; unset ${overridden.join(', ')}`);
	}
}

const run = (command, args, options = {}) =>
	new Promise((resolve, reject) => {
		console.log(`+ ${[command, ...args].map(shellQuote).join(' ')}`);
		const { capture = false, ...spawnOptions } = options;
		const child = spawn(command, args, {
			stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
			...spawnOptions,
			env: { ...process.env, ...(options.env || {}) }
		});
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on('data', (chunk) => {
			stderr += chunk;
		});
		child.on('error', reject);
		child.on('exit', (code) => {
			if (code === 0) resolve(capture ? stdout.trim() : undefined);
			else reject(new Error(`${command} exited with code ${code}${stderr ? `\n${stderr}` : ''}`));
		});
	});

function shellQuote(value) {
	if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function commandExists(command) {
	const paths = (process.env.PATH || '').split(path.delimiter);
	for (const directory of paths) {
		try {
			await fs.access(path.join(directory, command));
			return true;
		} catch {
			// Continue searching.
		}
	}
	return false;
}

async function requireCommand(command) {
	if (!(await commandExists(command))) throw new Error(`Missing required command: ${command}`);
}

async function download(url, target, expectedSha256) {
	await downloadPinned(url, target, expectedSha256);
}

async function assertSha256(filePath, expectedSha256, label) {
	const bytes = await fs.readFile(filePath);
	const actualSha256 = createHash('sha256').update(bytes).digest('hex');
	if (actualSha256 !== expectedSha256) {
		throw new Error(
			`${label} SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`
		);
	}
}

function detectWasiSdkHost() {
	const platform = os.platform();
	const arch = os.arch();
	if (platform === 'linux' && arch === 'x64') return 'x86_64-linux';
	if (platform === 'linux' && arch === 'arm64') return 'arm64-linux';
	if (platform === 'darwin' && arch === 'x64') return 'x86_64-macos';
	if (platform === 'darwin' && arch === 'arm64') return 'arm64-macos';
	throw new Error(`Unsupported host ${platform}-${arch}; set WASI_SDK_PATH`);
}

async function findDirectory(parent, name) {
	const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
	const match = entries.find((entry) => entry.isDirectory() && entry.name.startsWith(name));
	return match ? path.join(parent, match.name) : '';
}

async function findResourceIncludeDir(buildDir) {
	const clangDir = path.join(buildDir, 'lib', 'clang');
	const versions = await fs.readdir(clangDir, { withFileTypes: true }).catch(() => []);
	for (const version of versions) {
		if (!version.isDirectory()) continue;
		const includeDir = path.join(clangDir, version.name, 'include');
		try {
			await fs.access(includeDir);
			return includeDir;
		} catch {
			// Continue searching.
		}
	}
	return '';
}

async function findFile(root, predicate) {
	const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const entryPath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			const nested = await findFile(entryPath, predicate);
			if (nested) return nested;
			continue;
		}
		if (entry.isFile() && predicate(entryPath)) return entryPath;
	}
	return '';
}

function cmakeString(value) {
	return value.replaceAll('\\', '/').replaceAll('"', '\\"');
}

async function writeLlvmWasiToolchainFile(wasiSdkPath) {
	const suffix = process.platform === 'win32' ? '.exe' : '';
	const toolchainFile = path.join(toolsDir, 'llvm-wasi-generic-toolchain.cmake');
	const sysroot = path.join(wasiSdkPath, 'share', 'wasi-sysroot');
	const binDir = path.join(wasiSdkPath, 'bin');
	await fs.writeFile(
		toolchainFile,
		[
			'# Generated by wasm-llvm/producer/clang-browser/scripts/build-toolchain.mjs',
			'set(CMAKE_SYSTEM_NAME WASI)',
			'set(CMAKE_SYSTEM_VERSION 1)',
			'set(CMAKE_SYSTEM_PROCESSOR wasm32)',
			`set(CMAKE_SYSROOT "${cmakeString(sysroot)}")`,
			`set(CMAKE_C_COMPILER "${cmakeString(path.join(binDir, `clang${suffix}`))}")`,
			`set(CMAKE_CXX_COMPILER "${cmakeString(path.join(binDir, `clang++${suffix}`))}")`,
			`set(CMAKE_ASM_COMPILER "${cmakeString(path.join(binDir, `clang${suffix}`))}")`,
			`set(CMAKE_AR "${cmakeString(path.join(binDir, `llvm-ar${suffix}`))}")`,
			`set(CMAKE_RANLIB "${cmakeString(path.join(binDir, `llvm-ranlib${suffix}`))}")`,
			`set(CMAKE_LINKER "${cmakeString(path.join(binDir, `wasm-ld${suffix}`))}")`,
			`set(CMAKE_C_COMPILER_TARGET "${config.hostTriple}")`,
			`set(CMAKE_CXX_COMPILER_TARGET "${config.hostTriple}")`,
			`set(CMAKE_ASM_COMPILER_TARGET "${config.hostTriple}")`,
			`set(CMAKE_FIND_ROOT_PATH "${cmakeString(sysroot)}")`,
			'set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)',
			'set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)',
			'set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)',
			'set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)',
			''
		].join('\n')
	);
	return toolchainFile;
}

async function patchLlvmForWasiHost() {
	const result = await pinnedCommitPatch(
		llvmSource, config.yowaspWasiPatchRepo, config.yowaspWasiPatchCommit,
		path.join(llvmSource, '.wasm-llvm-yowasp-wasi-host.patch')
	);
	const signalsPath = path.join(llvmSource, 'llvm', 'lib', 'Support', 'Signals.cpp');
	await fs.writeFile(signalsPath, addWasiSignalStub(await fs.readFile(signalsPath, 'utf8')));
	return result;
}

async function applyChecksumPinnedPatch(patchSpec, label, markerName) {
	const patchPath = path.join(producerRoot, patchSpec.path);
	const marker = path.join(llvmSource, markerName);
	await assertSha256(patchPath, patchSpec.sha256, label);

	const markerSha256 = await fs.readFile(marker, 'utf8').catch(() => '');
	if (markerSha256) {
		if (markerSha256.trim() !== patchSpec.sha256) {
			throw new Error(`${label} marker does not match the producer manifest`);
		}
		await run('git', ['-C', llvmSource, 'apply', '--reverse', '--check', patchPath]);
		return;
	}

	try {
		await run('git', ['-C', llvmSource, 'apply', '--check', patchPath]);
		await run('git', ['-C', llvmSource, 'apply', patchPath]);
	} catch (error) {
		try {
			await run('git', ['-C', llvmSource, 'apply', '--reverse', '--check', patchPath]);
		} catch {
			throw error;
		}
	}
	await fs.writeFile(marker, `${patchSpec.sha256}\n`);
}

async function patchLlvmWasiClose() {
	await applyChecksumPinnedPatch(
		producerManifest.sources.llvmWasiClosePatch,
		'LLVM WASI close patch',
		'.wasm-llvm-wasi-close.patch'
	);
}

async function patchLldForWasmOnly() {
	await applyChecksumPinnedPatch(
		lldPatch,
		crossProfile ? 'LLD ELF-only patch' : 'LLD WebAssembly-only patch',
		crossProfile ? '.wasm-llvm-lld-elf-only.patch' : '.wasm-llvm-lld-wasm-only.patch'
	);
}

async function patchClangdForEmscriptenStdin() {
	await applyChecksumPinnedPatch(
		producerManifest.sources.clangdEmscriptenStdinPatch,
		'clangd Emscripten stdin patch',
		'.wasm-llvm-clangd-emscripten-stdin.patch'
	);
}

async function patchWasmFunctionEnd() {
	await applyChecksumPinnedPatch(
		producerManifest.sources.wasmFunctionEndPatch,
		'Wasm unoptimized function-end debug location patch',
		'.wasm-llvm-wasm-function-end.patch'
	);
}

const buildTools = {};
async function recordBuildTool(name, executable) {
	buildTools[name] = { ...await fileIdentity(executable),
		version: await run(executable, ['--version'], { capture: true }) };
	buildToolPaths[name] = executable;
}
const buildToolPaths = {};
async function recordPathTool(name, command) {
	for (const directory of (process.env.PATH || '').split(path.delimiter)) {
		const executable = path.join(directory, command);
		if (await fs.access(executable, fs.constants.X_OK).then(() => true, () => false)) {
			await recordBuildTool(name, executable);
			return;
		}
	}
	throw new Error(`Cannot resolve build tool: ${command}`);
}

const ninjaArgs = config.ninjaJobs ? ['-j', config.ninjaJobs] : [];
const wasiCompileFlags =
	'-DBYTE_ORDER=1234 -DLITTLE_ENDIAN=1234 -DBIG_ENDIAN=4321 -D_WASI_EMULATED_MMAN -flto' +
	(toolHostProfile ? ' -DLLVM_WASM_IDLE_TOOL_HOST=1' : '');
// --no-wasm-opt keeps the WASI SDK driver from running whichever Binaryen is on PATH at link time;
// the pinned Emscripten SDK's wasm-opt applies the same optimization after the build. Like the
// driver does for its own wasm-opt run, keep target_features so Binaryen enables the same features.
const wasiLinkerFlags =
	'-lwasi-emulated-mman -Wl,--max-memory=4294967296 -Wl,-z,stack-size=8388608,--stack-first -flto -Wl,--strip-all -Wl,--keep-section=target_features --no-wasm-opt' +
	(toolHostProfile ? ` "${cmakeString(path.join(config.workDir, 'build', 'tool-host-initial-cwd.o'))}"` : '');
const downloadDir = path.join(config.workDir, 'downloads');
const sourceDir = path.join(config.workDir, 'src');
const buildDir = path.join(config.workDir, 'build');
const toolsDir = path.join(config.workDir, 'tools');
const stagingSysroot = path.join(config.workDir, 'staging-sysroot');
const llvmSource = path.join(sourceDir, 'llvm-project');

for (const command of ['cmake', 'git', 'ninja', 'node', 'tar']) await requireCommand(command);
if (!(await commandExists('curl')) && !(await commandExists('wget'))) {
	throw new Error('Missing required command: curl or wget');
}
if (!config.llvmCommit) {
	throw new Error('LLVM_COMMIT is required when LLVM_VERSION overrides the producer manifest');
}
if (!config.emsdkCommit) {
	throw new Error('EMSDK_COMMIT is required when EMSDK_VERSION overrides the producer manifest');
}

// Every qualified build starts without prior object files, generated tools or linker outputs.
await claimFreshBuildDirectory(buildDir);
process.env.PYTHONDONTWRITEBYTECODE = '1';
await fs.mkdir(config.workDir, { recursive: true });
await fs.mkdir(tempDir, { recursive: true });
await fs.mkdir(downloadDir, { recursive: true });
await fs.mkdir(sourceDir, { recursive: true });
await fs.mkdir(buildDir, { recursive: true });
await fs.mkdir(toolsDir, { recursive: true });
const recipeFiles = ['build-toolchain.mjs', 'build-provenance.mjs', 'build-memfs.mjs',
	'prepare-clangd-headers.mjs', 'sysroot-pruning.mjs', 'gcc-compat.mjs', 'hot-path-launcher.sh',
	'resource-profile.mjs'];
const recipe = [];
for (const file of recipeFiles) recipe.push({ path: `scripts/${file}`, ...await fileIdentity(path.join(scriptDir, file)) });
for (const command of ['cmake', 'ninja', 'tar']) await recordPathTool(command, command);

try {
	await fs.access(path.join(llvmSource, '.git'));
} catch {
	await run('git', [
		'clone',
		'--depth',
		'1',
		'--branch',
		`llvmorg-${config.llvmVersion}`,
		producerManifest.sources.llvm.repository,
		llvmSource
	]);
}
const llvmHead = await run('git', ['-C', llvmSource, 'rev-parse', 'HEAD'], { capture: true });
if (llvmHead !== config.llvmCommit) {
	throw new Error(
		`LLVM checkout mismatch: expected ${config.llvmCommit}, got ${llvmHead}. Use a clean WASM_LLVM_TOOLCHAIN_WORK_DIR.`
	);
}
const yowaspPatch = await patchLlvmForWasiHost();
await patchLlvmWasiClose();
await patchLldForWasmOnly();
await patchClangdForEmscriptenStdin();
await patchWasmFunctionEnd();
if (toolHostProfile) {
	// Same pinned patch input as the isolated cached rebuild (build.py); the work dir is fresh.
	await assertSha256(
		path.join(llvmSource, 'llvm/lib/Support/Program.cpp'),
		toolHostProfile.baselineProgramSha256,
		'tool-host Program.cpp baseline'
	);
	await applyChecksumPinnedPatch(
		{ ...toolHostProfile.patch, path: `tool-host/${toolHostProfile.patch.path}` },
		'LLVM synchronous tool-host patch',
		'.wasm-llvm-tool-host.patch'
	);
}
const llvmPatchSpecs = [producerManifest.sources.llvmWasiClosePatch,
	lldPatch, producerManifest.sources.clangdEmscriptenStdinPatch,
	producerManifest.sources.wasmFunctionEndPatch,
	...(toolHostProfile ? [{ ...toolHostProfile.patch, path: `tool-host/${toolHostProfile.patch.path}` }] : [])];
const llvmVerification = {
	source: llvmSource, commit: config.llvmCommit,
	patches: [yowaspPatch.patch, ...await Promise.all(llvmPatchSpecs.map((spec) => fs.readFile(path.join(producerRoot, spec.path))))],
	transforms: [{ file: 'llvm/lib/Support/Signals.cpp', transform: addWasiSignalStub }],
	allowedUntracked: ['.wasm-llvm-yowasp-wasi-host.patch', '.wasm-llvm-wasi-close.patch',
		crossProfile ? '.wasm-llvm-lld-elf-only.patch' : '.wasm-llvm-lld-wasm-only.patch', '.wasm-llvm-clangd-emscripten-stdin.patch',
		'.wasm-llvm-wasm-function-end.patch',
		...(toolHostProfile ? ['.wasm-llvm-tool-host.patch'] : [])]
};
const llvmSourceIdentity = await verifyPatchedCheckout(llvmVerification);
await fs.writeFile(yowaspPatch.marker, `${JSON.stringify(yowaspPatch.identity)}\n`);

let wasiSdkPath = process.env.WASI_SDK_PATH || '';
if (wasiSdkPath) wasiSdkPath = path.resolve(wasiSdkPath);
if (!wasiSdkPath) {
	const host = process.env.WASI_SDK_HOST || detectWasiSdkHost();
	const archive = `wasi-sdk-${config.wasiSdkVersion}.0-${host}.tar.gz`;
	const archivePath = path.join(downloadDir, archive);
	const archiveSha256 = producerManifest.toolchains.wasiSdk.archives[host];
	if (!archiveSha256) {
		throw new Error(`No pinned WASI SDK archive SHA-256 for host ${host}`);
	}
	await download(
		`https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${config.wasiSdkVersion}/${archive}`,
		archivePath,
		archiveSha256
	);
	await assertSha256(archivePath, archiveSha256, `WASI SDK ${host} archive`);
	const extractedDir = path.join(toolsDir, `wasi-sdk-${archiveSha256}`);
	await extractPinnedArchive(archivePath, extractedDir, archiveSha256, run);
	wasiSdkPath = await findDirectory(extractedDir, `wasi-sdk-${config.wasiSdkVersion}.0`);
}
if (!wasiSdkPath) throw new Error('Could not find WASI_SDK_PATH');
const llvmWasiToolchainFile = await writeLlvmWasiToolchainFile(wasiSdkPath);
const wasiSdkIdentity = await directoryIdentity(wasiSdkPath);
await recordBuildTool('wasiClang', path.join(wasiSdkPath, 'bin', 'clang'));
await recordBuildTool('wasiClangxx', path.join(wasiSdkPath, 'bin', 'clang++'));
await recordBuildTool('wasiAr', path.join(wasiSdkPath, 'bin', 'llvm-ar'));
await recordBuildTool('wasiRanlib', path.join(wasiSdkPath, 'bin', 'llvm-ranlib'));
await recordBuildTool('wasiLld', path.join(wasiSdkPath, 'bin', 'wasm-ld'));
if (toolHostProfile) {
	const initializer = path.join(producerRoot, 'tool-host', toolHostProfile.initialCwd.path);
	await assertSha256(initializer, toolHostProfile.initialCwd.sha256, 'tool-host cwd initializer');
	await run(path.join(wasiSdkPath, 'bin', 'clang'), [
		`--target=${config.hostTriple}`, '-Oz', '-flto', '-c', initializer,
		'-o', path.join(buildDir, 'tool-host-initial-cwd.o')
	]);
}

const sysrootArchive = `wasi-sysroot-${config.wasiSdkVersion}.0+m.tar.gz`;
const clangRtArchive = `libclang_rt-${config.wasiSdkVersion}.0+m.tar.gz`;
if (!crossProfile) {
	await download(
		`https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${config.wasiSdkVersion}/wasi-sysroot-${config.wasiSdkVersion}.0%2Bm.tar.gz`,
		path.join(downloadDir, sysrootArchive),
		producerManifest.toolchains.wasiSdk.sysrootSha256
	);
	await download(
		`https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${config.wasiSdkVersion}/libclang_rt-${config.wasiSdkVersion}.0%2Bm.tar.gz`,
		path.join(downloadDir, clangRtArchive),
		producerManifest.toolchains.wasiSdk.clangRtSha256
	);
	await assertSha256(
		path.join(downloadDir, sysrootArchive),
		producerManifest.toolchains.wasiSdk.sysrootSha256,
		'WASI sysroot archive'
	);
	await assertSha256(
		path.join(downloadDir, clangRtArchive),
		producerManifest.toolchains.wasiSdk.clangRtSha256,
		'WASI compiler-rt archive'
	);
}
const { wasmPath: memfsWasm, receiptPath: memfsReceipt } = await buildMemfs({
	wasiSdkPath,
	wasiSdkVersion: config.wasiSdkVersion,
	workDir: path.join(buildDir, 'memfs'),
	outDir: path.join(buildDir, 'memfs-artifacts')
});

const nativeBuild = path.join(buildDir, 'native');
await run('cmake', [
	'-G',
	'Ninja',
	'-S',
	path.join(llvmSource, 'llvm'),
	'-B',
	nativeBuild,
	'-DCMAKE_BUILD_TYPE=Release',
	'-DLLVM_ENABLE_PROJECTS=clang',
	`-DLLVM_TARGETS_TO_BUILD=${crossProfile?.llvmTarget || 'WebAssembly'}`,
	'-DLLVM_INCLUDE_TESTS=OFF',
	'-DLLVM_INCLUDE_EXAMPLES=OFF'
]);
const nativeCache = await fs.readFile(path.join(nativeBuild, 'CMakeCache.txt'), 'utf8');
for (const [name, key] of [['nativeC', 'CMAKE_C_COMPILER'], ['nativeCxx', 'CMAKE_CXX_COMPILER']]) {
	const executable = nativeCache.split('\n').find((line) => line.startsWith(`${key}:FILEPATH=`))?.split('=').slice(1).join('=');
	if (!executable) throw new Error(`Native build did not resolve ${key}`);
	await recordBuildTool(name, executable);
}
await run('cmake', [
	'--build',
	nativeBuild,
	'--target',
	'llvm-tblgen',
	'clang-tblgen',
	...ninjaArgs
]);

await recordBuildTool('llvmTablegen', path.join(nativeBuild, 'bin', 'llvm-tblgen'));
await recordBuildTool('clangTablegen', path.join(nativeBuild, 'bin', 'clang-tblgen'));
const wasiBuild = path.join(buildDir, 'wasi-raw');
const hotPathLauncher =
	config.llvmHotPathOpt === 'none'
		? ''
		: [
				path.join(scriptDir, 'hot-path-launcher.sh'),
				config.llvmHotPathOpt,
				config.llvmHotPathDirs.map((dir) => path.join(llvmSource, dir)).join(':')
			].join(';');
// An empty launcher clears a previous configuration in a reused build directory.
const hotPathLauncherArgs = [
	`-DCMAKE_C_COMPILER_LAUNCHER=${hotPathLauncher}`,
	`-DCMAKE_CXX_COMPILER_LAUNCHER=${hotPathLauncher}`
];
await run('cmake', [
	'-G',
	'Ninja',
	'-S',
	path.join(llvmSource, 'llvm'),
	'-B',
	wasiBuild,
	`-DCMAKE_TOOLCHAIN_FILE=${llvmWasiToolchainFile}`,
	`-DCMAKE_BUILD_TYPE=${config.llvmBuildType}`,
	`-DCMAKE_C_FLAGS_MINSIZEREL=-${config.llvmMinSizeOpt} -DNDEBUG`,
	`-DCMAKE_CXX_FLAGS_MINSIZEREL=-${config.llvmMinSizeOpt} -DNDEBUG`,
	`-DCMAKE_C_FLAGS=${wasiCompileFlags}`,
	`-DCMAKE_CXX_FLAGS=${wasiCompileFlags}`,
	`-DCMAKE_EXE_LINKER_FLAGS=${wasiLinkerFlags}`,
	...hotPathLauncherArgs,
	`-DLLVM_HOST_TRIPLE=${config.hostTriple}`,
	`-DLLVM_DEFAULT_TARGET_TRIPLE=${config.targetTriple}`,
	`-DLLVM_TARGETS_TO_BUILD=${crossProfile?.llvmTarget || 'WebAssembly'}`,
	'-DLLVM_ENABLE_PROJECTS=clang;lld',
	`-DLLVM_TABLEGEN=${path.join(nativeBuild, 'bin', 'llvm-tblgen')}`,
	`-DCLANG_TABLEGEN=${path.join(nativeBuild, 'bin', 'clang-tblgen')}`,
	'-DLLVM_BUILD_STATIC=ON',
	'-DLLVM_BUILD_RUNTIME=OFF',
	'-DLLVM_BUILD_TOOLS=ON',
	'-DLLVM_BUILD_UTILS=OFF',
	'-DLLVM_INCLUDE_DOCS=OFF',
	'-DLLVM_INCLUDE_TESTS=OFF',
	'-DLLVM_INCLUDE_EXAMPLES=OFF',
	'-DLLVM_INCLUDE_BENCHMARKS=OFF',
	'-DLLVM_INCLUDE_RUNTIMES=OFF',
	'-DLLVM_INCLUDE_UTILS=OFF',
	'-DLLVM_TOOL_LLVM_DRIVER_BUILD=ON',
	'-DLLVM_DISTRIBUTION_COMPONENTS=clang',
	'-DLLVM_ENABLE_BACKTRACES=OFF',
	'-DLLVM_ENABLE_BINDINGS=OFF',
	'-DLLVM_ENABLE_CRASH_OVERRIDES=OFF',
	'-DLLVM_ENABLE_LIBEDIT=OFF',
	'-DLLVM_ENABLE_LIBXML2=OFF',
	'-DLLVM_ENABLE_PIC=OFF',
	'-DLLVM_ENABLE_TERMINFO=OFF',
	'-DLLVM_ENABLE_THREADS=OFF',
	'-DLLVM_ENABLE_UNWIND_TABLES=OFF',
	'-DLLVM_ENABLE_ZLIB=OFF',
	'-DLLVM_ENABLE_ZSTD=OFF',
	'-DCLANG_BUILD_EXAMPLES=OFF',
	'-DCLANG_BUILD_TOOLS=ON',
	'-DCLANG_ENABLE_ARCMT=OFF',
	'-DCLANG_ENABLE_STATIC_ANALYZER=OFF',
	'-DCLANG_INCLUDE_DOCS=OFF',
	'-DCLANG_INCLUDE_TESTS=OFF',
	'-DCLANG_LINKS_TO_CREATE=clang;clang++',
	'-DLLD_BUILD_TOOLS=ON'
]);
await run('cmake', [
	'--build',
	wasiBuild,
	'--target',
	'llvm-driver',
	'lld',
	'clang-resource-headers',
	...ninjaArgs
]);

const resourceIncludeDir = await findResourceIncludeDir(wasiBuild);
if (!resourceIncludeDir) throw new Error('Could not find clang resource headers');
const resourceVersion = path.basename(path.dirname(resourceIncludeDir));
const libcxxIncludeDir = path.join(stagingSysroot, 'include', 'c++', 'v1');
const stagedResourceIncludeDir = path.join(stagingSysroot, 'lib', 'clang', resourceVersion, 'include');

// Native targets import a real GNU/Linux sysroot separately. WASI compatibility
// headers and libraries must never be mounted into the native target bundle.
if (!crossProfile) {
	await fs.rm(stagingSysroot, { recursive: true, force: true });
	await fs.mkdir(stagingSysroot, { recursive: true });
	await run('tar', [
		'-xzf',
		path.join(downloadDir, sysrootArchive),
		'-C',
		stagingSysroot,
		'--strip-components=1'
	]);
	const libcxxShareDir = path.join(stagingSysroot, 'share', 'libc++', 'v1');
	let hasLibcxxInclude = false;
	try {
		await fs.access(path.join(libcxxIncludeDir, 'vector'));
		hasLibcxxInclude = true;
	} catch {
		for (const candidate of [
			libcxxShareDir,
			path.join(stagingSysroot, 'include', config.targetTriple, 'noeh', 'c++', 'v1'),
			path.join(stagingSysroot, 'include', config.targetTriple, 'eh', 'c++', 'v1')
		]) {
			try {
				await fs.access(path.join(candidate, 'vector'));
				await fs.mkdir(path.dirname(libcxxIncludeDir), { recursive: true });
				await fs.cp(candidate, libcxxIncludeDir, { recursive: true, force: true });
				hasLibcxxInclude = true;
				break;
			} catch {
				// Try the next libc++ location.
			}
		}
	}
	if (!hasLibcxxInclude) {
		throw new Error(`Could not find libc++ headers for ${config.targetTriple}`);
	}
	for (const header of GCC_COMPATIBILITY_HEADERS) {
		const target = path.join(stagingSysroot, header.path);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, header.contents);
	}
	await fs.rm(stagedResourceIncludeDir, { recursive: true, force: true });
	await fs.mkdir(path.dirname(stagedResourceIncludeDir), { recursive: true });
	await fs.cp(resourceIncludeDir, stagedResourceIncludeDir, { recursive: true, force: true });

	const clangRtTemp = path.join(config.workDir, 'clang-rt');
	await fs.rm(clangRtTemp, { recursive: true, force: true });
	await fs.mkdir(clangRtTemp, { recursive: true });
	await run('tar', [
		'-xzf',
		path.join(downloadDir, clangRtArchive),
		'-C',
		clangRtTemp,
		'--strip-components=1'
	]);
	const clangRtSource = await findFile(
		clangRtTemp,
		(filePath) =>
			filePath.endsWith('libclang_rt.builtins.a') &&
			(filePath.includes('wasm32-unknown-wasi') || filePath.includes('wasm32-unknown-wasip1'))
	);
	if (!clangRtSource) throw new Error('Could not find libclang_rt.builtins.a');
	const clangRtTarget = path.join(
		stagingSysroot,
		'lib',
		'clang',
		resourceVersion,
		'lib',
		'wasi',
		'libclang_rt.builtins-wasm32.a'
	);
	await fs.mkdir(path.dirname(clangRtTarget), { recursive: true });
	await fs.copyFile(clangRtSource, clangRtTarget);
}

const emsdkDir = path.join(config.workDir, 'emsdk');
try {
	await fs.access(emsdkDir);
} catch {
	await run('git', [
		'clone',
		'--branch',
		config.emsdkVersion,
		'--depth',
		'1',
		'https://github.com/emscripten-core/emsdk',
		emsdkDir
	]);
}
const emsdkHead = await run('git', ['-C', emsdkDir, 'rev-parse', 'HEAD'], { capture: true });
if (emsdkHead !== config.emsdkCommit) {
	throw new Error(
		`Emscripten SDK checkout mismatch: expected ${config.emsdkCommit}, got ${emsdkHead}. Use a clean WASM_LLVM_TOOLCHAIN_WORK_DIR.`
	);
}
const emsdkSourceIdentity = await verifyPatchedCheckout({ source: emsdkDir, commit: config.emsdkCommit, allowIgnored: true });
await run(path.join(emsdkDir, 'emsdk'), ['install', config.emsdkVersion]);
await run(path.join(emsdkDir, 'emsdk'), ['activate', config.emsdkVersion]);
await recordBuildTool('emsdkClang', path.join(emsdkDir, 'upstream', 'bin', 'clang'));
await recordBuildTool('wasmOpt', path.join(emsdkDir, 'upstream', 'bin', 'wasm-opt'));
const emccIdentity = await fileIdentity(path.join(emsdkDir, 'upstream', 'emscripten', 'emcc.py'));
// Emscripten lazily writes compiled system libraries. Keep those generated outputs
// in this fresh build while hashing every installed helper, source and library input.
const emsdkUpstream = path.join(emsdkDir, 'upstream');
const emsdkUpstreamIdentity = await directoryIdentity(emsdkUpstream);
const emCache = path.join(buildDir, 'emscripten-cache');
await fs.cp(path.join(emsdkUpstream, 'emscripten', 'cache'), emCache, { recursive: true });
process.env.EM_CACHE = emCache;

// The level the WASI SDK driver derives from the configuration's link-time -O flag.
const wasmOptLevel = {
	MinSizeRel: config.llvmMinSizeOpt,
	Release: 'O3',
	RelWithDebInfo: 'O2'
}[config.llvmBuildType];
const effectiveWasmOptLevel =
	config.clangWasmOpt === 'default' ? wasmOptLevel : config.clangWasmOpt;
let clangWasm = path.join(wasiBuild, 'bin', 'llvm');
let lldWasm = path.join(wasiBuild, 'bin', 'lld');
if (effectiveWasmOptLevel) {
	const wasmOpt = path.join(emsdkDir, 'upstream', 'bin', 'wasm-opt');
	const optimizedDir = path.join(buildDir, 'wasm-opt');
	await fs.mkdir(optimizedDir, { recursive: true });
	const optimizedClang = path.join(optimizedDir, 'llvm');
	const optimizedLld = path.join(optimizedDir, 'lld');
	await run(wasmOpt, [`-${effectiveWasmOptLevel}`, clangWasm, '-o', optimizedClang]);
	await run(wasmOpt, [`-${effectiveWasmOptLevel}`, lldWasm, '-o', optimizedLld]);
	clangWasm = optimizedClang;
	lldWasm = optimizedLld;
}

if (compilerOnly) {
	const compilerOutDir = path.join(config.outDir, 'compiler');
	await fs.rm(compilerOutDir, { recursive: true, force: true });
	await fs.mkdir(compilerOutDir, { recursive: true });
	const modules = {};
	for (const [name, source] of [
		['clang', clangWasm],
		['lld', lldWasm]
	]) {
		const target = path.join(compilerOutDir, name);
		await fs.copyFile(source, target);
		const bytes = await fs.readFile(target);
		modules[name] = {
			bytes: bytes.length,
			sha256: createHash('sha256').update(bytes).digest('hex')
		};
	}
	const toolHostArtifacts = {};
	let crossArtifacts;
	if (crossProfile) {
		const resourceOutput = path.join(compilerOutDir, 'resource-include');
		await fs.cp(resourceIncludeDir, resourceOutput, { recursive: true, dereference: true });
		await fs.copyFile(path.join(producerRoot, 'cross/profile.json'), path.join(compilerOutDir, 'cross-profile.json'));
		await fs.copyFile(path.join(producerRoot, lldPatch.path), path.join(compilerOutDir, 'lld-elf-only.patch'));
		// Unlike the legacy compiler-only benchmark, this pack records source,
		// SDK and recipe identities and verifies the inputs again before handoff.
		await verifyPatchedCheckout(llvmVerification);
		await assertDirectoryUnchanged(wasiSdkPath, wasiSdkIdentity, 'WASI SDK');
		await assertDirectoryUnchanged(emsdkUpstream, emsdkUpstreamIdentity, 'Emscripten SDK');
		crossArtifacts = {
			profile: crossProfile,
			profileIdentity: await fileIdentity(path.join(compilerOutDir, 'cross-profile.json')),
			resourceVersion,
			resourceHeaders: await directoryIdentity(resourceOutput),
			source: { ...llvmSourceIdentity, patches: [yowaspPatch.identity, ...llvmPatchSpecs] },
			toolchains: { wasiSdk: wasiSdkIdentity, emsdk: emsdkUpstreamIdentity },
			tools: buildTools,
			recipe,
			qualification: 'unverified; run cross/qualify.mjs after packaging'
		};
	}
	if (toolHostProfile) {
		const profileOutput = path.join(compilerOutDir, 'tool-host');
		await fs.mkdir(profileOutput);
		for (const file of ['profile.json', 'llvm-tool-host.patch', 'initial-cwd.c', 'README.md']) {
			await fs.copyFile(path.join(producerRoot, 'tool-host', file), path.join(profileOutput, file));
		}
		await fs.copyFile(path.join(llvmSource, 'llvm/LICENSE.TXT'), path.join(profileOutput, 'LICENSE.LLVM.txt'));
		await fs.copyFile(path.join(llvmSource, 'llvm/lib/Support/Program.cpp'), path.join(profileOutput, 'Program.cpp'));
		await fs.copyFile(fileURLToPath(import.meta.url), path.join(profileOutput, 'build-toolchain.mjs'));
		await fs.writeFile(path.join(profileOutput, 'sources.json'), `${JSON.stringify(crossProfile ? { ...producerManifest.sources, lldWasmOnlyPatch: undefined, lldElfOnlyPatch: lldPatch } : producerManifest.sources, null, 2)}\n`);
		for (const name of ['clang', 'lld']) {
			await run('node', [path.join(producerRoot, 'tool-host/verify.mjs'), path.join(compilerOutDir, name),
				path.join(profileOutput, `${name}.module.json`), '--initial-cwd', `--kind=${name}`]);
		}
		for (const file of await fs.readdir(profileOutput)) {
			const bytes = await fs.readFile(path.join(profileOutput, file));
			toolHostArtifacts[file] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
		}
	}
	await fs.writeFile(
		path.join(compilerOutDir, 'compiler-build.json'),
		`${JSON.stringify(
			{
				llvmVersion: config.llvmVersion,
				llvmCommit: config.llvmCommit,
				wasiSdkVersion: config.wasiSdkVersion,
				emsdkVersion: config.emsdkVersion,
				llvmBuildType: config.llvmBuildType,
				llvmMinSizeOpt: config.llvmMinSizeOpt,
				llvmHotPathOpt: config.llvmHotPathOpt,
				llvmHotPathDirs: config.llvmHotPathOpt === 'none' ? [] : config.llvmHotPathDirs,
				clangWasmOpt: config.clangWasmOpt,
				wasmOptLevel: effectiveWasmOptLevel ?? 'none',
				...(toolHostProfile ? { toolHostProfile, toolHostArtifacts } : {}),
				...(crossArtifacts ? { cross: crossArtifacts } : {}),
				modules
			},
			null,
			2
		)}\n`
	);
	console.log(`Wrote WASI compiler modules to ${compilerOutDir}`);
	process.exit(0);
}

const clangdBuild = path.join(buildDir, 'clangd');
// Keep the complete selected C/C++ headers for clangd, independently of the
// dependency-pruned compiler sysroot packaged below.
const clangdIncludeDir = path.join(config.workDir, 'clangd-include');
await prepareClangdHeaders({
	sysroot: stagingSysroot,
	destination: clangdIncludeDir,
	targetTriple: config.targetTriple
});
const clangdHeaderLinkFlags =
	config.clangdSeparateHeaders === 'ON' ? '' : ` --embed-file=${clangdIncludeDir}@/usr/include`;
const emsdkEnv = path.join(emsdkDir, 'emsdk_env.sh');
const clangdConfigure = [
	'emcmake',
	'cmake',
	'-G',
	'Ninja',
	'-S',
	shellQuote(path.join(llvmSource, 'llvm')),
	'-B',
	shellQuote(clangdBuild),
	shellQuote('-DCMAKE_CXX_FLAGS=-pthread -Dwait4=__syscall_wait4'),
	shellQuote(
		`-DCMAKE_EXE_LINKER_FLAGS=-pthread -s ENVIRONMENT=worker -s NO_INVOKE_RUN -s EXIT_RUNTIME -s INITIAL_MEMORY=${config.clangdResources.initialMemoryMiB}MB -s ALLOW_MEMORY_GROWTH -s MAXIMUM_MEMORY=4GB -s STACK_SIZE=256kB -s EXPORTED_RUNTIME_METHODS=FS,callMain -s MODULARIZE -s EXPORT_ES6 -s WASM_BIGINT -s ASSERTIONS=${config.clangdAssertions === 'ON' ? 1 : 0} -s ASYNCIFY -s PTHREAD_POOL_SIZE='${config.clangdResources.poolExpression}'${clangdHeaderLinkFlags}`
	),
	`-DCMAKE_BUILD_TYPE=${config.llvmBuildType}`,
	shellQuote(`-DCMAKE_C_FLAGS_MINSIZEREL=-${config.llvmMinSizeOpt} -DNDEBUG`),
	shellQuote(`-DCMAKE_CXX_FLAGS_MINSIZEREL=-${config.llvmMinSizeOpt} -DNDEBUG`),
	'-DLLVM_TARGET_ARCH=wasm32-emscripten',
	`-DLLVM_ENABLE_LTO=${config.clangdLto}`,
	`-DCLANGD_TIDY_CHECKS=${config.clangdTidyChecks}`,
	`-DCLANGD_DECISION_FOREST=${config.clangdDecisionForest}`,
	`-DLLVM_DEFAULT_TARGET_TRIPLE=${config.targetTriple}`,
	'-DLLVM_TARGETS_TO_BUILD=WebAssembly',
	shellQuote('-DLLVM_ENABLE_PROJECTS=clang;clang-tools-extra'),
	shellQuote(`-DLLVM_TABLEGEN=${path.join(nativeBuild, 'bin', 'llvm-tblgen')}`),
	shellQuote(`-DCLANG_TABLEGEN=${path.join(nativeBuild, 'bin', 'clang-tblgen')}`),
	'-DLLVM_BUILD_STATIC=ON',
	'-DLLVM_INCLUDE_EXAMPLES=OFF',
	'-DLLVM_INCLUDE_TESTS=OFF',
	'-DLLVM_INCLUDE_BENCHMARKS=OFF',
	'-DLLVM_ENABLE_BACKTRACES=OFF',
	'-DLLVM_ENABLE_CRASH_OVERRIDES=OFF',
	'-DLLVM_ENABLE_LIBEDIT=OFF',
	'-DLLVM_ENABLE_LIBXML2=OFF',
	'-DLLVM_ENABLE_PIC=OFF',
	'-DLLVM_ENABLE_TERMINFO=OFF',
	'-DLLVM_ENABLE_ZLIB=OFF',
	'-DLLVM_ENABLE_ZSTD=OFF',
	'-DCLANG_ENABLE_ARCMT=OFF',
	'-DCLANG_ENABLE_STATIC_ANALYZER=OFF'
].join(' ');
await run('bash', ['-lc', emsdkShellCommand(emsdkEnv, emCache, clangdConfigure)]);
await run('bash', [
	'-lc',
	emsdkShellCommand(emsdkEnv, emCache,
		`cmake --build ${shellQuote(clangdBuild)} --target clangd ${ninjaArgs.map(shellQuote).join(' ')}`)
]);

for (const entry of await fs.readdir(path.join(stagingSysroot, 'include'), {
	withFileTypes: true
})) {
	if (!entry.isDirectory() || !entry.name.startsWith('wasm32-')) continue;
	if (entry.name !== config.targetTriple) {
		await fs.rm(path.join(stagingSysroot, 'include', entry.name), {
			recursive: true,
			force: true
		});
		continue;
	}
	for (const relativePath of ['c++', path.join('eh', 'c++'), path.join('noeh', 'c++')]) {
		await fs.rm(path.join(stagingSysroot, 'include', entry.name, relativePath), {
			recursive: true,
			force: true
		});
	}
}

const targetLibDir = path.join(stagingSysroot, 'lib', config.targetTriple);
const retainedTargetLibraries = [
	'crt1.o',
	'libc.a',
	'libc-printscan-long-double.a',
	'libc++.a',
	'libc++abi.a',
	'libm.a',
	'libwasi-emulated-mman.a'
];
for (const library of ['libc++.a', 'libc++abi.a']) {
	try {
		await fs.access(path.join(targetLibDir, library));
	} catch {
		await fs.copyFile(
			path.join(targetLibDir, 'noeh', library),
			path.join(targetLibDir, library)
		);
	}
}
for (const entry of await fs.readdir(path.join(stagingSysroot, 'lib'), {
	withFileTypes: true
})) {
	if (!entry.isDirectory() || !entry.name.startsWith('wasm32-')) continue;
	if (entry.name !== config.targetTriple) {
		await fs.rm(path.join(stagingSysroot, 'lib', entry.name), { recursive: true, force: true });
		continue;
	}
	for (const relativePath of ['eh', 'noeh', 'llvm-lto']) {
		await fs.rm(path.join(stagingSysroot, 'lib', entry.name, relativePath), {
			recursive: true,
			force: true
		});
	}
}
await fs.rm(path.join(stagingSysroot, 'share'), { recursive: true, force: true });
await fs.rm(path.join(stagingSysroot, 'VERSION'), { force: true });
for (const entry of await fs.readdir(targetLibDir, { withFileTypes: true }).catch(() => [])) {
	if (!entry.isFile()) continue;
	if (!retainedTargetLibraries.includes(entry.name)) {
		await fs.rm(path.join(targetLibDir, entry.name), { force: true });
	}
}
for (const library of retainedTargetLibraries) {
	try {
		await fs.access(path.join(targetLibDir, library));
	} catch {
		throw new Error(`Required staged sysroot library is missing: ${library}`);
	}
}

const probeDir = path.join(config.workDir, 'sysroot-probes');
await fs.rm(probeDir, { recursive: true, force: true });
await fs.mkdir(probeDir, { recursive: true });
const cProbe = path.join(probeDir, 'probe.c');
const cppProbe = path.join(probeDir, 'probe.cpp');
await fs.writeFile(cProbe, SYSROOT_C_PROBE);
await fs.writeFile(cppProbe, SYSROOT_CPP_PROBE);
const wasiBinDir = path.join(wasiSdkPath, 'bin');
const probeFlags = [
	`--target=${config.targetTriple}`,
	`--sysroot=${stagingSysroot}`,
	'-resource-dir',
	path.join(stagingSysroot, 'lib', 'clang', resourceVersion),
	`-I${path.join(stagingSysroot, 'include')}`
];
const targetIncludeFlags = ['-isystem', path.join(stagingSysroot, 'include', config.targetTriple)];
await pruneSysrootHeaders({
	sysroot: stagingSysroot,
	resourceIncludeDir: stagedResourceIncludeDir,
	probeDir,
	cCompiler: path.join(wasiBinDir, 'clang'),
	cppCompiler: path.join(wasiBinDir, 'clang++'),
	cFlags: [...probeFlags, ...targetIncludeFlags],
	cppFlags: [...probeFlags, '-isystem', libcxxIncludeDir, ...targetIncludeFlags],
	cProbe,
	cppProbe,
	run
});

// Bind the receipt to the exact TAR subsequently consumed by the packager.
const sysrootTar = path.join(config.workDir, 'sysroot-input.tar');
await run('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
	'-cf', sysrootTar, '-C', stagingSysroot, ...(await fs.readdir(stagingSysroot)).sort()]);
await verifyPatchedCheckout(llvmVerification);
await verifyPatchedCheckout({ source: emsdkDir, commit: config.emsdkCommit, allowIgnored: true });
for (const [name, executable] of Object.entries(buildToolPaths)) {
	await assertFileUnchanged(executable, buildTools[name], `Build tool ${name}`);
}
for (const entry of recipe) {
	await assertFileUnchanged(path.join(producerRoot, entry.path), entry, `Build recipe ${entry.path}`);
}
await assertFileUnchanged(producerManifestPath, producerManifestIdentity, 'Producer manifest');
await assertDirectoryUnchanged(wasiSdkPath, wasiSdkIdentity, 'Installed WASI SDK');
await assertDirectoryUnchanged(emsdkUpstream, emsdkUpstreamIdentity, 'Installed Emscripten SDK');
const inputs = {};
for (const [name, file] of Object.entries({ clang: clangWasm, lld: lldWasm, memfs: memfsWasm, memfsReceipt, sysroot: sysrootTar,
	clangdJs: path.join(clangdBuild, 'bin', 'clangd.js'), clangdWasm: path.join(clangdBuild, 'bin', 'clangd.wasm')
})) inputs[name] = await fileIdentity(file);
if (config.clangdSeparateHeaders === 'ON') {
	const headers = await createClangdHeaderAsset({ includeDir: clangdIncludeDir, resourceIncludeDir,
		resourceDir: `/lib/clang/${resourceVersion}`, targetTriple: config.targetTriple,
		version: `llvmorg-${config.llvmVersion}:${config.llvmCommit}` });
	inputs.clangdHeaders = { bytes: headers.length, sha256: createHash('sha256').update(headers).digest('hex') };
}
const { workDir: _workDir, outDir: _outDir, ...buildOptions } = config;
const buildReceipt = {
	schemaVersion: 1, producerId: producerManifest.producerId, kind: 'clang-build-receipt',
	manifestSha256: producerManifestIdentity.sha256,
	buildMode: 'fresh-output-directory',
	installedToolchains: { wasiSdk: wasiSdkIdentity, emsdkUpstream: emsdkUpstreamIdentity },
	sources: {
		llvm: { repository: producerManifest.sources.llvm.repository, ...llvmSourceIdentity,
			patches: [yowaspPatch.identity, ...llvmPatchSpecs] },
		emsdk: { repository: 'https://github.com/emscripten-core/emsdk', ...emsdkSourceIdentity }
	},
	recipe: { sha256: createHash('sha256').update(JSON.stringify(recipe)).digest('hex'), files: recipe },
	buildOptions: { ...buildOptions, environment: Object.fromEntries(
		['CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS', 'AR', 'RANLIB'].map((key) => [key, process.env[key] || ''])
	) }, tools: { ...buildTools, emccDriver: emccIdentity }, inputs,
	reproducibility: { independentlyRebuilt: false }
};
const buildReceiptPath = path.join(config.workDir, 'clang-build-receipt.json');
await fs.writeFile(buildReceiptPath, `${JSON.stringify(buildReceipt, null, 2)}\n`);

await run('node', [
	path.join(scriptDir, 'package-toolchain.mjs'),
	'--clang-wasm',
	clangWasm,
	'--lld-wasm',
	lldWasm,
	'--sysroot',
	sysrootTar,
	'--build-receipt',
	buildReceiptPath,
	'--memfs-wasm',
	memfsWasm,
	'--memfs-receipt',
	memfsReceipt,
	'--clangd-js',
	path.join(clangdBuild, 'bin', 'clangd.js'),
	'--clangd-wasm',
	path.join(clangdBuild, 'bin', 'clangd.wasm'),
	...(config.clangdSeparateHeaders === 'ON'
		? [
				'--clangd-include',
				clangdIncludeDir,
				'--clangd-resource-include',
				resourceIncludeDir,
				'--target-triple',
				config.targetTriple
			]
		: []),
	'--target-dir',
	config.outDir,
	'--llvm-version',
	config.llvmVersion,
	'--llvm-commit',
	config.llvmCommit,
	'--wasi-sdk-version',
	config.wasiSdkVersion,
	'--emsdk-version',
	config.emsdkVersion,
	'--resource-dir',
	`/lib/clang/${resourceVersion}`,
	'--compiler-runtime-lib-dir',
	`lib/clang/${resourceVersion}/lib/wasi`
]);

console.log(`Packaged wasm-llvm toolchain into ${config.outDir}`);
