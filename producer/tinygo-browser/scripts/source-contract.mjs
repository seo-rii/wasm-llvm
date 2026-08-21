import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const THIS_FILE = fileURLToPath(import.meta.url);
export const TINYGO_PRODUCER_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
export const SOURCE_RECEIPT_FORMAT = 'wasm-llvm-tinygo-source-v1';
export const COMPILER_RECEIPT_FORMAT = 'wasm-llvm-tinygo-browser-compiler-v6';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REQUIRED_IDENTITY_PATHS = [
	'GNUmakefile',
	'builder/build.go',
	'builder/cc.go',
	'builder/cc1as.cpp',
	'builder/cc1as.h',
	'builder/clang.cpp',
	'builder/lld.cpp',
	'builder/tools-builtin.go',
	'cgo/libclang.go',
	'compiler/compiler.go',
	'go.mod',
	'go.sum',
	'interp/interp.go',
	'loader/loader.go',
	'main.go',
	'transform/transform.go'
];
const REQUIRED_GO_LLVM_HOST_SUPPORT_PATHS = [
	'IRBindings.cpp',
	'IRBindings.h',
	'SupportBindings.cpp',
	'SupportBindings.h',
	'backports.cpp',
	'backports.h'
];
const REQUIRED_PATCH_PATHS = [
	'patches/tinygo-wasi-adapter.patch',
	'patches/go-llvm-wasi-cgo-alias.patch',
	'patches/go-toolchain-wasip1-exec.patch',
	'patches/llvm-wasi-c-api-config.patch'
];
const REQUIRED_COMPILER_PACKAGES = [
	'github.com/tinygo-org/tinygo/builder',
	'github.com/tinygo-org/tinygo/cgo',
	'github.com/tinygo-org/tinygo/compiler',
	'github.com/tinygo-org/tinygo/interp',
	'github.com/tinygo-org/tinygo/loader',
	'github.com/tinygo-org/tinygo/transform',
	'tinygo.org/x/go-llvm'
];
const REQUIRED_OUTPUTS = ['tinygo-compiler.wasm', 'tinygoroot.tar.gz'];
const REQUIRED_COMPILE_OUTPUTS = ['objects', 'link-plan.json'];
const REQUIRED_ACCEPTANCE_FEATURES = [
	'maps',
	'slices',
	'structs',
	'methods',
	'interfaces',
	'go:embed',
	'generics',
	'package-init',
	'goroutines',
	'channels',
	'cgo',
	'c',
	'hosted-cxx-noeh',
	'clang-assembly',
	'cgo-cxxflags',
	'cgo-linker-flags',
	'stdin'
];

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

export function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function assertCommit(value, label) {
	assert(COMMIT_PATTERN.test(value ?? ''), `${label} must be a full 40-character Git commit`);
}

function assertSha256(value, label) {
	assert(SHA256_PATTERN.test(value ?? ''), `${label} must be a SHA-256 digest`);
}

function assertSafeRelativePath(value, label) {
	assert(typeof value === 'string' && value.length > 0, `${label} must be a non-empty path`);
	assert(!path.isAbsolute(value), `${label} must be relative`);
	const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
	assert(normalized === value && normalized !== '..' && !normalized.startsWith('../'), `${label} is unsafe`);
}

function assertExactArray(actual, expected, label) {
	assert(Array.isArray(actual), `${label} must be an array`);
	assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} does not match the contract`);
}

export function validateTinyGoSourceLock(lock) {
	assert(lock?.schemaVersion === 1, 'sources.lock.json must use schemaVersion 1');
	for (const [name, source] of [
		['tinygo', lock?.tinygo],
		['goLlvm', lock?.goLlvm],
		['llvm', lock?.llvm]
	]) {
		assert(typeof source?.repository === 'string' && source.repository.length > 0, `${name}.repository is required`);
		assertCommit(source?.commit, `${name}.commit`);
	}
	assert(lock.tinygo.module === 'github.com/tinygo-org/tinygo', 'unexpected TinyGo module identity');
	assert(lock.tinygo.ref === `v${lock.tinygo.version}`, 'TinyGo ref and version must agree');
	assert(lock.goLlvm.module === 'tinygo.org/x/go-llvm', 'unexpected go-llvm module identity');
	assert(
		lock.goLlvm.version?.endsWith(`-${lock.goLlvm.commit.slice(0, 12)}`),
		'go-llvm pseudo-version does not identify the pinned commit'
	);
	assert(typeof lock.goLlvm.sum === 'string' && lock.goLlvm.sum.startsWith('h1:'), 'go-llvm sum is required');
	assert(
		typeof lock.goLlvm.goModSum === 'string' && lock.goLlvm.goModSum.startsWith('h1:'),
		'go-llvm go.mod sum is required'
	);
	assertExactArray(
		lock.goLlvm.hostSupportSources?.map((entry) => entry.path),
		REQUIRED_GO_LLVM_HOST_SUPPORT_PATHS,
		'go-llvm host support source paths'
	);
	for (const entry of lock.goLlvm.hostSupportSources) {
		assertSafeRelativePath(entry.path, `go-llvm host support path ${entry.path}`);
		assertSha256(entry.sha256, `${entry.path} SHA-256`);
	}
	const goToolchain = lock.goToolchain;
	assert(goToolchain?.module === 'golang.org/toolchain', 'unexpected Go toolchain module identity');
	assert(goToolchain?.version === 'go1.24.6', 'Go toolchain must be pinned to go1.24.6');
	assert(goToolchain?.platform === 'linux-amd64', 'Go bootstrap platform must be linux-amd64');
	assert(
		goToolchain.archiveFilename === 'v0.0.1-go1.24.6.linux-amd64.zip' &&
			goToolchain.archiveRoot ===
				'golang.org/toolchain@v0.0.1-go1.24.6.linux-amd64',
		'Go bootstrap archive identity is invalid'
	);
	assert(
		Number.isSafeInteger(goToolchain.archiveBytes) && goToolchain.archiveBytes > 0,
		'Go bootstrap archive size is invalid'
	);
	assertSha256(goToolchain.archiveSha256, 'Go bootstrap archive SHA-256');
	assert(
		goToolchain.patchedSource?.path === 'src/os/exec/exec.go',
		'Go bootstrap patch source is invalid'
	);
	assertSha256(goToolchain.patchedSource.sha256, 'Go bootstrap patch source SHA-256');
	assert(lock.llvm.ref === 'tinygo_20.x', 'LLVM must use the TinyGo 20.x branch');
	assert(lock.llvm.version === '20.1.1', 'LLVM source version must be 20.1.1');
	const wasiHostPatch = lock.wasiHostPatch;
	assert(
		typeof wasiHostPatch?.repository === 'string' &&
			wasiHostPatch.repository.startsWith('https://github.com/'),
		'wasiHostPatch.repository must be a GitHub source'
	);
	assertCommit(wasiHostPatch?.commit, 'wasiHostPatch.commit');
	assertCommit(wasiHostPatch?.parent, 'wasiHostPatch.parent');
	assert(
		wasiHostPatch.commit !== wasiHostPatch.parent,
		'wasiHostPatch commit and parent must differ'
	);
	assert(
		Array.isArray(wasiHostPatch.expectedPaths) &&
			wasiHostPatch.expectedPaths.length > 0,
		'wasiHostPatch.expectedPaths must be non-empty'
	);
	const wasiHostPatchPaths = new Set();
	for (const patchPath of wasiHostPatch.expectedPaths) {
		assertSafeRelativePath(patchPath, `WASI host patch path ${patchPath}`);
		assert(!wasiHostPatchPaths.has(patchPath), `duplicate WASI host patch path ${patchPath}`);
		wasiHostPatchPaths.add(patchPath);
	}
	assert(
		Array.isArray(wasiHostPatch.excludedPaths) &&
			wasiHostPatch.excludedPaths.length > 0,
		'wasiHostPatch.excludedPaths must be non-empty'
	);
	for (const excludedPath of wasiHostPatch.excludedPaths) {
		assertSafeRelativePath(excludedPath, `excluded WASI host patch path ${excludedPath}`);
		assert(
			wasiHostPatchPaths.has(excludedPath),
			`excluded WASI host patch path ${excludedPath} is not in expectedPaths`
		);
	}

	const identity = lock.compilerIdentity;
	assert(identity?.module === lock.tinygo.module, 'compiler identity module differs from TinyGo');
	assert(identity?.entrypoint === 'main.go', 'compiler identity must use upstream main.go');
	assert(
		identity?.goLlvmRequirement === lock.goLlvm.version,
		'compiler identity go-llvm requirement differs from the source lock'
	);
	assertExactArray(identity?.requiredPackages, REQUIRED_COMPILER_PACKAGES, 'required compiler packages');
	assert(Array.isArray(identity?.requiredSources), 'compilerIdentity.requiredSources must be an array');
	assertExactArray(
		identity.requiredSources.map((entry) => entry.path),
		REQUIRED_IDENTITY_PATHS,
		'required compiler source paths'
	);
	for (const entry of identity.requiredSources) {
		assertSafeRelativePath(entry.path, `compiler identity path ${entry.path}`);
		assertSha256(entry.sha256, `${entry.path} SHA-256`);
		assert(
			Array.isArray(entry.requiredText) &&
				entry.requiredText.length > 0 &&
				entry.requiredText.every((value) => typeof value === 'string' && value.length > 0),
			`${entry.path} must define required source evidence`
		);
		if (entry.package !== undefined) {
			assert(/^[a-z][a-z0-9_]*$/u.test(entry.package), `${entry.path} has an invalid Go package`);
		}
	}

	assert(Array.isArray(lock.patches), 'patches must be an array');
	const patchPaths = new Set();
	for (const patch of lock.patches) {
		assertSafeRelativePath(patch.path, `patch path ${patch.path}`);
		assert(patch.path.startsWith('patches/'), `${patch.path} must be under patches/`);
		assert(!patchPaths.has(patch.path), `duplicate locked patch ${patch.path}`);
		patchPaths.add(patch.path);
		assertSha256(patch.sha256, `${patch.path} SHA-256`);
	}
	assertExactArray([...patchPaths], REQUIRED_PATCH_PATHS, 'registered TinyGo producer patches');
	return lock;
}

export function validateTinyGoManifest(manifest, lock) {
	assert(manifest?.schemaVersion === 1, 'manifest.json must use schemaVersion 1');
	assert(manifest?.producerId === 'wasm-llvm/tinygo-browser', 'unexpected TinyGo producer id');
	assert(manifest?.tinygoVersion === lock.tinygo.version, 'manifest TinyGo version differs from source lock');
	assert(manifest?.sourcesLock === 'sources.lock.json', 'manifest must reference sources.lock.json');
	assert(manifest?.target === 'wasm32-wasip1', 'TinyGo compiler host target must be wasm32-wasip1');
	assert(
		JSON.stringify(manifest?.upstreamCompiler?.entrypoint) ===
			JSON.stringify({
				modes: ['upstream-cli', 'upstream-compiler-adapter'],
				upstreamModule: lock.tinygo.module,
				referenceCliFile: lock.compilerIdentity.entrypoint
			}),
		'manifest does not constrain entrypoints to upstream TinyGo packages'
	);
	assertExactArray(
		manifest?.upstreamCompiler?.requiredPackages,
		lock.compilerIdentity.requiredPackages,
		'manifest required compiler packages'
	);
	assert(manifest?.upstreamCompiler?.cgoRequired === true, 'upstream TinyGo must retain cgo');
	assert(
		manifest?.upstreamCompiler?.llvmLinkage === 'in-process-c-api',
		'upstream TinyGo must retain in-process LLVM C API linkage'
	);
	assert(
		manifest?.upstreamCompiler?.hostCompileFallbackAllowed === false,
		'host compile fallback must not satisfy the browser compiler contract'
	);
	assertExactArray(manifest?.patches, lock.patches, 'manifest patch set');
	assert(manifest?.compileProtocol?.version === 6, 'TinyGo compile protocol must use version 6');
	assert(
		manifest?.compileProtocol?.format === 'wasm-llvm-tinygo-link-plan-v6',
		'TinyGo compile protocol must identify link-plan v6'
	);
	assertExactArray(
		manifest?.compileProtocol?.capabilities,
		[
			'go-embed-objects',
			'target-cgo-c',
			'target-cxx-hosted-noeh',
			'target-clang-assembly',
			'target-cgo-cxxflags',
			'target-cgo-linker-flags'
		],
		'TinyGo compile protocol capabilities'
	);
	assertExactArray(
		manifest?.compileProtocol?.outputs,
		REQUIRED_COMPILE_OUTPUTS,
		'TinyGo adapter compile outputs'
	);
	assert(
		JSON.stringify(manifest?.compileProtocol?.targetNativeSourcePolicy) ===
			JSON.stringify({
				cgoFiles: 'program-object-with-source-closure-v6',
				cFiles: 'thinlto-object-set-v6',
				cxxFiles: 'hosted-noeh-libcxx-thinlto-object-set-v6',
				sFiles: 'clang-uppercase-s-wasm-object-set-v4',
				embedFiles: 'generated-object-set-v2'
			}),
		'TinyGo compile protocol must disclose its target native-source limitation'
	);
	assert(
		JSON.stringify(manifest?.compileProtocol?.targetNativeValidation) ===
			JSON.stringify({
				llvmToolchain: 'llvm-20.1.1',
				targetTriple: 'wasm32-unknown-wasi',
				dataLayout:
					'e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128-ni:1:10:20',
				moduleVerifier: 'llvm-bitreader+verify-module',
				wasmObjectVerifier: 'llvm-object-wasm',
				wasmObjectProfile: 'wasm-relocatable-object-v1',
				enabledTargetFeatures: [
					'bulk-memory',
					'bulk-memory-opt',
					'call-indirect-overlong',
					'mutable-globals',
					'nontrapping-fptoint',
					'sign-ext'
				],
				disabledTargetFeatures: ['multivalue', 'reference-types'],
				allowedWasmLimitsFlags: ['has-max'],
				maximumTotalMemories: 1,
				maximumTotalTables: 1,
				cPolicy: 'no-tls-ctors-dtors-forbidden-target-features',
				cxxPolicy: 'libcxx-libcxxabi-noeh-nortti-no-global-ctors-dtors-v1'
			}),
		'TinyGo compile protocol must pin its target-native validation boundary'
	);
	assert(
		JSON.stringify(manifest?.compileProtocol?.runtimeProfile) ===
			JSON.stringify({
				id: 'wasip1-asyncify-precise-o1',
				target: 'wasip1',
				opt: '1',
				gc: 'precise',
				panicStrategy: 'print',
				scheduler: 'asyncify',
				debug: false,
				parallelism: 1
			}),
		'TinyGo compile protocol must pin the packaged runtime profile'
	);
	assert(
		JSON.stringify(manifest?.rootArchive) ===
			JSON.stringify({
				format: 'wasm-llvm-tinygo-browser-root-v1',
				requiredPaths: [
					'src',
					'go.env',
					'targets',
					'go.mod',
					'go.sum',
					'lib/clang',
					'lib/wasi-libc/include',
					'lib/wasi-libc/include/c++/v1',
					'runtime'
				],
				omittedTinyGoPaths: [
					'lib except receipt-bound Clang, wasi-libc, and libc++ headers'
				],
				runtimeClosureFormat: 'wasm-llvm-tinygo-runtime-closure-v2',
				runtimeProbe: {
					fixture: 'fixtures/runtime-closure-probe/main.go',
					sha256: '55a60bb97151b2b4b680462447ce60ec34511b14fa10d77440c97b9777101566'
				}
			}),
		'TinyGo root archive contract must pin its merged GOROOT and runtime closure'
	);
	assert(
		manifest?.finalization?.linker === 'wasm-llvm/raw-wasi-lld' &&
			manifest?.finalization?.optimizer === 'binaryen/wasm-opt',
		'TinyGo finalization must use wasm-llvm LLD and Binaryen'
	);
	assertExactArray(
		manifest?.finalization?.forbiddenLinkArguments,
		['--thinlto-cache-dir'],
		'TinyGo forbidden link arguments'
	);
	for (const [name, fixturePath] of Object.entries({
		fixture: manifest?.acceptance?.fixture,
		embed: manifest?.acceptance?.embed,
		stdin: manifest?.acceptance?.stdin,
		stdout: manifest?.acceptance?.stdout
	})) {
		assertSafeRelativePath(fixturePath, `TinyGo acceptance ${name}`);
		assert(fixturePath.startsWith('fixtures/'), `TinyGo acceptance ${name} must be under fixtures/`);
	}
	assert(
		Array.isArray(manifest?.acceptance?.nativeSources) &&
			manifest.acceptance.nativeSources.length === 4,
		'TinyGo acceptance must identify its CGo, C, C++, and assembly sources'
	);
	const nativeSourcePaths = new Set();
	for (const sourcePath of manifest.acceptance.nativeSources) {
		assertSafeRelativePath(sourcePath, `TinyGo acceptance native source ${sourcePath}`);
		assert(
			sourcePath.startsWith('fixtures/upstream-language-smoke/'),
			`TinyGo acceptance native source ${sourcePath} must be under the fixture`
		);
		assert(!nativeSourcePaths.has(sourcePath), `duplicate TinyGo acceptance native source ${sourcePath}`);
		nativeSourcePaths.add(sourcePath);
	}
	assert(
		JSON.stringify([...nativeSourcePaths]) ===
			JSON.stringify([
				'fixtures/upstream-language-smoke/cgo.go',
				'fixtures/upstream-language-smoke/helper.c',
				'fixtures/upstream-language-smoke/helper.cpp',
				'fixtures/upstream-language-smoke/helper.S'
			]),
		'TinyGo acceptance native source set differs from the CGo+C+C++/assembly contract'
	);
	assertExactArray(
		manifest?.acceptance?.requiredFeatures,
		REQUIRED_ACCEPTANCE_FEATURES,
		'TinyGo acceptance features'
	);
	assertExactArray(manifest?.outputs, [...REQUIRED_OUTPUTS, 'producer-receipt.json'], 'manifest outputs');
	assert(
		manifest?.contracts?.sourceReceipt === 'contracts/tinygo-source-receipt.schema.json',
		'manifest source receipt contract is missing'
	);
	assert(
		manifest?.contracts?.compilerReceipt === 'contracts/tinygo-browser-receipt.schema.json',
		'manifest compiler receipt contract is missing'
	);
	return manifest;
}

export async function verifyTinyGoLockedPatches(
	lock,
	producerRoot = TINYGO_PRODUCER_ROOT
) {
	validateTinyGoSourceLock(lock);
	const patchFiles = [];
	for (const patch of lock.patches) {
		const patchPath = path.join(producerRoot, patch.path);
		const bytes = await readFile(patchPath);
		const actualSha256 = sha256(bytes);
		assert(
			actualSha256 === patch.sha256,
			`${patch.path} does not match the registered patch SHA-256`
		);
		patchFiles.push({ path: patch.path, bytes: bytes.length, sha256: actualSha256 });
	}
	return patchFiles;
}

export async function loadTinyGoProducerContract(producerRoot = TINYGO_PRODUCER_ROOT) {
	const paths = {
		manifest: path.join(producerRoot, 'manifest.json'),
		sourcesLock: path.join(producerRoot, 'sources.lock.json'),
		sourceContract: path.join(producerRoot, 'scripts/source-contract.mjs'),
		prepareSource: path.join(producerRoot, 'scripts/prepare-source.mjs')
	};
	const [manifestBytes, sourcesLockBytes, sourceContractBytes, prepareSourceBytes] =
		await Promise.all([
			readFile(paths.manifest),
			readFile(paths.sourcesLock),
			readFile(paths.sourceContract),
			readFile(paths.prepareSource)
		]);
	const manifest = JSON.parse(manifestBytes);
	const lock = validateTinyGoSourceLock(JSON.parse(sourcesLockBytes));
	validateTinyGoManifest(manifest, lock);
	const [acceptanceSourceBytes, acceptanceEmbedBytes, acceptanceStdinBytes, acceptanceStdoutBytes, patchFiles] =
		await Promise.all([
			readFile(path.join(producerRoot, manifest.acceptance.fixture)),
			readFile(path.join(producerRoot, manifest.acceptance.embed)),
			readFile(path.join(producerRoot, manifest.acceptance.stdin)),
			readFile(path.join(producerRoot, manifest.acceptance.stdout)),
			verifyTinyGoLockedPatches(lock, producerRoot)
		]);
	const runtimeProbeBytes = await readFile(
		path.join(producerRoot, manifest.rootArchive.runtimeProbe.fixture)
	);
	assert(
		sha256(runtimeProbeBytes) === manifest.rootArchive.runtimeProbe.sha256,
		'TinyGo runtime closure probe differs from the manifest'
	);
	const acceptanceNativeSources = await Promise.all(
		manifest.acceptance.nativeSources.map(async (sourcePath) => ({
			path: sourcePath,
			sha256: sha256(await readFile(path.join(producerRoot, sourcePath)))
		}))
	);
	return {
		manifest,
		lock,
		patchFiles,
		bytes: { manifestBytes, sourcesLockBytes, sourceContractBytes, prepareSourceBytes },
		inputs: {
			manifestSha256: sha256(manifestBytes),
			sourcesLockSha256: sha256(sourcesLockBytes),
			sourceContractSha256: sha256(sourceContractBytes),
			prepareSourceSha256: sha256(prepareSourceBytes)
		},
		acceptance: {
			sourceSha256: sha256(acceptanceSourceBytes),
			nativeSources: acceptanceNativeSources,
			embedSha256: sha256(acceptanceEmbedBytes),
			stdinSha256: sha256(acceptanceStdinBytes),
			stdoutSha256: sha256(acceptanceStdoutBytes),
			expectedStdout: acceptanceStdoutBytes.toString('utf8')
		}
	};
}

async function runGit(sourceDir, args) {
	const { stdout } = await execFileAsync('git', ['-C', sourceDir, ...args], {
		encoding: 'utf8',
		maxBuffer: 1024 * 1024
	});
	return stdout.trimEnd();
}

export async function verifyTinyGoSourceIdentity({ sourceDir, lock, gitImpl = runGit }) {
	validateTinyGoSourceLock(lock);
	const resolvedCommit = (await gitImpl(sourceDir, ['rev-parse', 'HEAD'])).trim();
	assert(
		resolvedCommit === lock.tinygo.commit,
		`TinyGo checkout commit mismatch: expected ${lock.tinygo.commit}, received ${resolvedCommit || '<missing>'}`
	);
	const worktreeStatus = await gitImpl(sourceDir, [
		'status',
		'--porcelain=v1',
		'--untracked-files=all'
	]);
	assert(
		worktreeStatus.trim() === '',
		`TinyGo checkout contains unregistered patches or generated sources:\n${worktreeStatus}`
	);

	const sourceFiles = [];
	for (const entry of lock.compilerIdentity.requiredSources) {
		const sourcePath = path.join(sourceDir, entry.path);
		const bytes = await readFile(sourcePath);
		const actualSha256 = sha256(bytes);
		assert(
			actualSha256 === entry.sha256,
			`${entry.path} does not match upstream TinyGo ${lock.tinygo.ref}`
		);
		const source = bytes.toString('utf8');
		if (entry.package) {
			assert(
				new RegExp(`^package\\s+${entry.package}\\s*$`, 'mu').test(source),
				`${entry.path} is not package ${entry.package}`
			);
		}
		for (const evidence of entry.requiredText) {
			assert(source.includes(evidence), `${entry.path} is missing upstream compiler evidence: ${evidence}`);
		}
		assert(!source.includes('/wasmbridge/'), `${entry.path} contains a custom wasmbridge import`);
		assert(!source.includes('tinygobackend'), `${entry.path} contains the subset TinyGo backend`);
		sourceFiles.push({ path: entry.path, bytes: bytes.length, sha256: actualSha256 });
	}

	const goMod = await readFile(path.join(sourceDir, 'go.mod'), 'utf8');
	assert(
		new RegExp(`^module\\s+${lock.tinygo.module.replaceAll('.', '\\.')}\\s*$`, 'mu').test(goMod),
		'TinyGo go.mod has the wrong module identity'
	);
	assert(
		goMod.includes(`${lock.goLlvm.module} ${lock.goLlvm.version}`),
		'TinyGo go.mod does not require the pinned go-llvm module'
	);
	const goSum = await readFile(path.join(sourceDir, 'go.sum'), 'utf8');
	const goSumLines = new Set(goSum.split(/\r?\n/u));
	for (const [kind, line] of [
		['module', `${lock.goLlvm.module} ${lock.goLlvm.version} ${lock.goLlvm.sum}`],
		['go.mod', `${lock.goLlvm.module} ${lock.goLlvm.version}/go.mod ${lock.goLlvm.goModSum}`]
	]) {
		assert(goSumLines.has(line), `TinyGo go.sum is missing the pinned go-llvm ${kind} checksum`);
	}

	return {
		source: { ...lock.tinygo, clean: true },
		compilerIdentity: {
			entrypoint: lock.compilerIdentity.entrypoint,
			requiredPackages: [...lock.compilerIdentity.requiredPackages],
			sourceFiles,
			goLlvm: { ...lock.goLlvm }
		},
		llvm: { ...lock.llvm },
		patches: lock.patches.map((patch) => ({ ...patch }))
	};
}

export function createTinyGoSourceReceipt({ manifest, lock, identity, inputs }) {
	validateTinyGoManifest(manifest, validateTinyGoSourceLock(lock));
	for (const [name, digest] of Object.entries(inputs)) assertSha256(digest, `receipt input ${name}`);
	return {
		schemaVersion: 1,
		format: SOURCE_RECEIPT_FORMAT,
		producerId: manifest.producerId,
		inputs: {
			manifestSha256: inputs.manifestSha256,
			sourcesLockSha256: inputs.sourcesLockSha256,
			sourceContractSha256: inputs.sourceContractSha256,
			prepareSourceSha256: inputs.prepareSourceSha256
		},
		source: identity.source,
		compilerIdentity: identity.compilerIdentity,
		llvm: identity.llvm,
		patches: identity.patches
	};
}

export function validateTinyGoSourceReceipt(receipt, { manifest, lock, inputs }) {
	assert(receipt?.schemaVersion === 1, 'TinyGo source receipt must use schemaVersion 1');
	assert(receipt?.format === SOURCE_RECEIPT_FORMAT, 'unexpected TinyGo source receipt format');
	assert(receipt?.producerId === manifest.producerId, 'TinyGo source receipt producer differs');
	assert(
		JSON.stringify(receipt?.inputs) ===
			JSON.stringify({
				manifestSha256: inputs.manifestSha256,
				sourcesLockSha256: inputs.sourcesLockSha256,
				sourceContractSha256: inputs.sourceContractSha256,
				prepareSourceSha256: inputs.prepareSourceSha256
			}),
		'TinyGo source receipt does not match current producer inputs'
	);
	assert(
		JSON.stringify(receipt?.source) === JSON.stringify({ ...lock.tinygo, clean: true }),
		'TinyGo source receipt does not identify the locked clean checkout'
	);
	assert(
		receipt?.compilerIdentity?.entrypoint === lock.compilerIdentity.entrypoint,
		'TinyGo source receipt does not identify upstream main.go'
	);
	assertExactArray(
		receipt?.compilerIdentity?.requiredPackages,
		lock.compilerIdentity.requiredPackages,
		'TinyGo source receipt package identity'
	);
	assert(
		JSON.stringify(receipt?.compilerIdentity?.goLlvm) === JSON.stringify(lock.goLlvm),
		'TinyGo source receipt go-llvm identity differs from the source lock'
	);
	const expectedFiles = lock.compilerIdentity.requiredSources.map(({ path: sourcePath, sha256: digest }) => ({
		path: sourcePath,
		sha256: digest
	}));
	assert(Array.isArray(receipt?.compilerIdentity?.sourceFiles), 'source receipt files are missing');
	assert(
		receipt.compilerIdentity.sourceFiles.length === expectedFiles.length,
		'source receipt file count differs from the source lock'
	);
	for (const [index, expected] of expectedFiles.entries()) {
		const actual = receipt.compilerIdentity.sourceFiles[index];
		assert(actual?.path === expected.path, `source receipt file ${index} has the wrong path`);
		assert(actual?.sha256 === expected.sha256, `${expected.path} receipt hash differs from source lock`);
		assert(Number.isInteger(actual?.bytes) && actual.bytes > 0, `${expected.path} receipt size is invalid`);
	}
	assert(JSON.stringify(receipt?.llvm) === JSON.stringify(lock.llvm), 'source receipt LLVM differs');
	assert(JSON.stringify(receipt?.patches) === JSON.stringify(lock.patches), 'source receipt patches differ');
	return receipt;
}

export async function prepareTinyGoSourceReceipt({
	sourceDir,
	receiptPath,
	producerRoot = TINYGO_PRODUCER_ROOT,
	gitImpl = runGit
}) {
	const contract = await loadTinyGoProducerContract(producerRoot);
	const identity = await verifyTinyGoSourceIdentity({ sourceDir, lock: contract.lock, gitImpl });
	const receipt = createTinyGoSourceReceipt({
		manifest: contract.manifest,
		lock: contract.lock,
		identity,
		inputs: contract.inputs
	});
	validateTinyGoSourceReceipt(receipt, contract);
	await mkdir(path.dirname(receiptPath), { recursive: true });
	await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
	return receipt;
}

export async function verifyTinyGoSourceReceipt({
	sourceDir,
	receiptPath,
	producerRoot = TINYGO_PRODUCER_ROOT,
	gitImpl = runGit
}) {
	const contract = await loadTinyGoProducerContract(producerRoot);
	const [receipt, identity] = await Promise.all([
		readFile(receiptPath, 'utf8').then(JSON.parse),
		verifyTinyGoSourceIdentity({ sourceDir, lock: contract.lock, gitImpl })
	]);
	validateTinyGoSourceReceipt(receipt, contract);
	const expected = createTinyGoSourceReceipt({
		manifest: contract.manifest,
		lock: contract.lock,
		identity,
		inputs: contract.inputs
	});
	assert(
		JSON.stringify(receipt) === JSON.stringify(expected),
		'TinyGo source receipt does not match the verified checkout'
	);
	return receipt;
}

export function validateTinyGoCompilerReceipt(
	receipt,
	{
		manifest,
		lock,
		sourceReceipt,
		acceptance,
		manifestSha256,
		sourcesLockSha256,
		sourceReceiptSha256
	}
) {
	assert(receipt?.schemaVersion === 6, 'TinyGo compiler receipt must use schemaVersion 6');
	assert(receipt?.format === COMPILER_RECEIPT_FORMAT, 'unexpected TinyGo compiler receipt format');
	assert(receipt?.producerId === manifest.producerId, 'TinyGo compiler receipt producer differs');
	assert(!('artifactKind' in receipt), 'artifactKind labels are not compiler identity evidence');
	assert(
		JSON.stringify(receipt?.inputs) ===
			JSON.stringify({ manifestSha256, sourcesLockSha256, sourceReceiptSha256 }),
		'TinyGo compiler receipt does not bind the current source lock and source receipt'
	);
	assert(
		JSON.stringify(receipt?.source) ===
			JSON.stringify({
				tinygoCommit: lock.tinygo.commit,
				goLlvmCommit: lock.goLlvm.commit,
				llvmCommit: lock.llvm.commit
			}),
		'TinyGo compiler receipt source revisions differ from the source lock'
	);
	assert(
		manifest.upstreamCompiler.entrypoint.modes.includes(receipt?.build?.entrypoint?.mode) &&
			receipt.build.entrypoint.upstreamModule === lock.tinygo.module &&
			receipt.build.entrypoint.referenceCliFile === lock.compilerIdentity.entrypoint,
		'TinyGo compiler build entrypoint is not an upstream CLI or package adapter'
	);
	assert(receipt?.build?.hostTarget === manifest.target, 'TinyGo compiler host target differs');
	assert(receipt?.build?.cgoEnabled === true, 'TinyGo compiler receipt must prove cgo is enabled');
	assert(
		receipt?.build?.llvmLinkage === 'in-process-c-api',
		'TinyGo compiler receipt must prove in-process go-llvm linkage'
	);
	assert(
		receipt?.build?.hostCompileFallback === false,
		'host compilation fallback cannot satisfy the browser compiler contract'
	);
	assert(Array.isArray(receipt?.build?.packageGraph), 'TinyGo compiler package graph is missing');
	for (const requiredPackage of lock.compilerIdentity.requiredPackages) {
		assert(
			receipt.build.packageGraph.includes(requiredPackage),
			`TinyGo compiler package graph is missing ${requiredPackage}`
		);
	}
	assertExactArray(
		receipt?.build?.compileOutputs,
		manifest.compileProtocol.outputs,
		'TinyGo adapter compile outputs'
	);
	assert(
		JSON.stringify(receipt?.build?.compileProtocol) ===
			JSON.stringify({
				version: manifest.compileProtocol.version,
				format: manifest.compileProtocol.format,
				capabilities: manifest.compileProtocol.capabilities
			}),
		'TinyGo compiler receipt compile protocol differs from the manifest'
	);
	assert(
		JSON.stringify(receipt?.build?.runtimeProfile) ===
			JSON.stringify(manifest.compileProtocol.runtimeProfile),
		'TinyGo compiler receipt runtime profile differs from the manifest'
	);
	assert(
		JSON.stringify(receipt?.build?.rootArchive) ===
			JSON.stringify(manifest.rootArchive),
		'TinyGo compiler receipt root archive contract differs from the manifest'
	);
	assert(
		receipt?.build?.finalization?.linker === manifest.finalization.linker &&
			receipt?.build?.finalization?.optimizer === manifest.finalization.optimizer,
		'TinyGo compiler receipt has the wrong external finalization pipeline'
	);
	assert(
		Array.isArray(receipt?.build?.finalization?.linkArguments),
		'TinyGo compiler receipt link arguments are missing'
	);
	for (const argument of receipt.build.finalization.linkArguments) {
		for (const forbidden of manifest.finalization.forbiddenLinkArguments) {
			assert(
				argument !== forbidden && !argument.startsWith(`${forbidden}=`),
				`TinyGo link plan contains unsupported argument ${forbidden}`
			);
		}
	}
	assert(
		receipt?.verification?.status === 'passed' &&
			receipt?.verification?.identityMode === 'upstream-package-graph',
		'TinyGo compiler package identity probe has not passed'
	);
	assert(
		new RegExp(`^tinygo version ${lock.tinygo.version.replaceAll('.', '\\.')}(?:\\s|$)`, 'u').test(
			receipt?.verification?.compilerVersion ?? ''
		),
		'TinyGo compiler version probe differs from the locked upstream version'
	);
	assert(receipt?.verification?.acceptance?.status === 'passed', 'TinyGo acceptance fixture has not passed');
	assert(
		JSON.stringify(receipt.verification.acceptance.fixture) ===
			JSON.stringify({
				sourceSha256: acceptance.sourceSha256,
				nativeSources: acceptance.nativeSources,
				embedSha256: acceptance.embedSha256,
				stdinSha256: acceptance.stdinSha256,
				stdoutSha256: acceptance.stdoutSha256
			}),
		'TinyGo acceptance receipt does not identify the checked-in fixture'
	);
	const acceptanceCompile = receipt.verification.acceptance.compile;
	assert(Array.isArray(acceptanceCompile?.objects), 'TinyGo acceptance object evidence is missing');
	assert(acceptanceCompile.objects.length >= 5, 'TinyGo CGo+C+C++/assembly+embed acceptance must emit at least five objects');
	let seenEmbed = false;
	for (const [index, evidence] of acceptanceCompile.objects.entries()) {
		let suffix = 'program.o';
		if (index !== 0) {
			const nativeSuffixes = ['target-c.bc', 'target-cxx.bc', 'target-assembly.o'];
			const nativeRank = nativeSuffixes.findIndex((candidate) => evidence?.path?.endsWith(`-${candidate}`));
			if (nativeRank !== -1) {
				assert(!seenEmbed, 'TinyGo acceptance target-native objects must precede embed objects');
				suffix = nativeSuffixes[nativeRank];
			} else if (evidence?.path?.endsWith('-embed.o')) {
				seenEmbed = true;
				suffix = 'embed.o';
			} else {
				throw new Error(`TinyGo acceptance object ${index} has an unknown kind`);
			}
		}
		const expectedPath = `objects/${String(index).padStart(4, '0')}-${suffix}`;
		assert(
			evidence?.path === expectedPath,
			`TinyGo acceptance object ${index} path differs`
		);
		assert(Number.isInteger(evidence?.bytes) && evidence.bytes > 0, `TinyGo acceptance object ${index} size is invalid`);
		assertSha256(evidence?.sha256, `TinyGo acceptance object ${index} SHA-256`);
	}
	assert(
		acceptanceCompile.objects.some((evidence) => evidence.path.endsWith('-target-c.bc')) &&
			acceptanceCompile.objects.some((evidence) => evidence.path.endsWith('-target-cxx.bc')) &&
			acceptanceCompile.objects.some((evidence) => evidence.path.endsWith('-target-assembly.o')) &&
			acceptanceCompile.objects.some((evidence) => evidence.path.endsWith('-embed.o')),
		'TinyGo acceptance must prove C, C++, assembly, and embed auxiliary outputs'
	);
	const linkPlanEvidence = acceptanceCompile?.linkPlan;
	assert(linkPlanEvidence?.path === 'link-plan.json', 'TinyGo acceptance linkPlan path differs');
	assert(Number.isInteger(linkPlanEvidence?.bytes) && linkPlanEvidence.bytes > 0, 'TinyGo acceptance linkPlan size is invalid');
	assertSha256(linkPlanEvidence?.sha256, 'TinyGo acceptance linkPlan SHA-256');
	assertSha256(acceptanceCompile?.finalWasmSha256, 'TinyGo acceptance final Wasm SHA-256');
	assert(
		receipt.verification.acceptance.execution?.exitCode === 0 &&
			receipt.verification.acceptance.execution.stdout === acceptance.expectedStdout &&
			receipt.verification.acceptance.execution.stdoutSha256 === acceptance.stdoutSha256,
		'TinyGo acceptance execution does not match the checked-in expected output'
	);
	assertExactArray(
		receipt?.assets?.map((asset) => asset.path),
		REQUIRED_OUTPUTS,
		'TinyGo compiler receipt assets'
	);
	for (const asset of receipt.assets) {
		assert(Number.isInteger(asset.bytes) && asset.bytes > 0, `${asset.path} receipt size is invalid`);
		assertSha256(asset.sha256, `${asset.path} receipt SHA-256`);
	}
	assert(
		sourceReceipt?.source?.commit === lock.tinygo.commit &&
			sourceReceipt?.compilerIdentity?.goLlvm?.commit === lock.goLlvm.commit &&
			sourceReceipt?.llvm?.commit === lock.llvm.commit,
		'TinyGo compiler receipt is not backed by the locked source receipt'
	);
	const serialized = JSON.stringify(receipt);
	for (const forbidden of manifest.upstreamCompiler.forbiddenArtifactIdentityStrings) {
		assert(!serialized.includes(forbidden), `TinyGo compiler receipt contains forbidden custom path ${forbidden}`);
	}
	return receipt;
}
