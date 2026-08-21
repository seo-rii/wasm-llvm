import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
	createTinyGoSourceReceipt,
	loadTinyGoProducerContract,
	sha256,
	TINYGO_PRODUCER_ROOT,
	validateTinyGoCompilerReceipt,
	validateTinyGoSourceReceipt,
	verifyTinyGoLockedPatches,
	verifyTinyGoSourceIdentity
} from '../scripts/source-contract.mjs';
import {
	verifyTinyGoArtifactPayloads,
	verifyTinyGoCompilerArtifacts
} from '../scripts/verify-artifacts.mjs';
import {
	ensurePinnedTinyGoCheckout,
	parsePrepareSourceArgs
} from '../scripts/prepare-source.mjs';

const tempDirs = [];
const fixtureSources = {
	'GNUmakefile':
		'git clone -b tinygo_20.x --depth=1 https://github.com/tinygo-org/llvm-project llvm-project\n',
	'builder/build.go': `package builder
import (
	"github.com/tinygo-org/tinygo/compiler"
	"github.com/tinygo-org/tinygo/interp"
	"github.com/tinygo-org/tinygo/loader"
	"github.com/tinygo-org/tinygo/transform"
	"tinygo.org/x/go-llvm"
)
func Build(
`,
	'builder/cc.go': `package builder
func compileAndCacheCFile(
func nativeFlags() {
	_ = "-flto=thin"
	runCCompiler(
}
`,
	'builder/cc1as.cpp': `
bool AssemblerInvocation::CreateFromArgs() { return ExecuteAssembler(); }
`,
	'builder/cc1as.h': `
struct AssemblerInvocation {};
bool ExecuteAssembler();
`,
	'builder/clang.cpp': `
bool tinygo_clang_driver() { return ExecuteCompilerInvocation(); }
`,
	'builder/lld.cpp': `
bool tinygo_link() { return lld::lldMain(); }
`,
	'builder/tools-builtin.go': `//go:build byollvm

package builder

// bool tinygo_clang_driver(
// bool tinygo_link(
`,
	'cgo/libclang.go': `package cgo
/*
#include <clang-c/Index.h>
*/
import "C"
import "tinygo.org/x/go-llvm"
// C.clang_parseTranslationUnit2(
`,
	'compiler/compiler.go': `package compiler
import (
	"github.com/tinygo-org/tinygo/loader"
	"tinygo.org/x/go-llvm"
)
func CompilePackage(
`,
	'go.mod': `module github.com/tinygo-org/tinygo

go 1.22.0

require tinygo.org/x/go-llvm v0.0.0-20250422114502-b8f170971e74
`,
	'go.sum': `tinygo.org/x/go-llvm v0.0.0-20250422114502-b8f170971e74 h1:ovavgTdIBWCH8YWlcfq9gkpoyT1+IxMKSn+Df27QwE8=
tinygo.org/x/go-llvm v0.0.0-20250422114502-b8f170971e74/go.mod h1:GFbusT2VTA4I+l4j80b17KFK+6whv69Wtny5U+T8RR0=
`,
	'interp/interp.go': `package interp
import "tinygo.org/x/go-llvm"
func Run(
`,
	'loader/loader.go': 'package loader\n',
	'main.go': `package main
import (
	"github.com/tinygo-org/tinygo/builder"
	"tinygo.org/x/go-llvm"
)
func main() { builder.Build(
`,
	'transform/transform.go': `package transform
import "tinygo.org/x/go-llvm"
`
};

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

async function createSourceFixture() {
	const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'wasm-llvm-tinygo-source-'));
	tempDirs.push(sourceDir);
	for (const [relativePath, source] of Object.entries(fixtureSources)) {
		const outputPath = path.join(sourceDir, relativePath);
		await mkdir(path.dirname(outputPath), { recursive: true });
		await writeFile(outputPath, source);
	}
	return sourceDir;
}

function fixtureLock(contract) {
	const lock = structuredClone(contract.lock);
	for (const entry of lock.compilerIdentity.requiredSources) {
		entry.sha256 = createHash('sha256').update(fixtureSources[entry.path]).digest('hex');
	}
	return lock;
}

function cleanGit(lock, status = '') {
	return async (_sourceDir, args) => {
		if (args[0] === 'rev-parse') return lock.tinygo.commit;
		if (args[0] === 'status') return status;
		throw new Error(`Unexpected git invocation: ${args.join(' ')}`);
	};
}

function producerInputs(character = 'a') {
	return {
		manifestSha256: character.repeat(64),
		sourcesLockSha256: String.fromCharCode(character.charCodeAt(0) + 1).repeat(64),
		sourceContractSha256: String.fromCharCode(character.charCodeAt(0) + 2).repeat(64),
		prepareSourceSha256: String.fromCharCode(character.charCodeAt(0) + 3).repeat(64)
	};
}

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

function wasmWithIdentity(strings, { importModule = null } = {}) {
	const name = Buffer.from('tinygo.provenance');
	const payload = Buffer.from(strings.join('\0'));
	const section = Buffer.concat([encodeUleb(name.length), name, payload]);
	const standardSections = [];
	if (importModule) {
		const moduleName = Buffer.from(importModule);
		const importName = Buffer.from('stub');
		const typeSection = Buffer.from([0x01, 0x60, 0x00, 0x00]);
		const importSection = Buffer.concat([
			Buffer.from([0x01]),
			encodeUleb(moduleName.length),
			moduleName,
			encodeUleb(importName.length),
			importName,
			Buffer.from([0x00, 0x00])
		]);
		standardSections.push(
			Buffer.concat([Buffer.from([0x01]), encodeUleb(typeSection.length), typeSection]),
			Buffer.concat([Buffer.from([0x02]), encodeUleb(importSection.length), importSection])
		);
	}
	return Buffer.concat([
		Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
		...standardSections,
		Buffer.from([0x00]),
		encodeUleb(section.length),
		section
	]);
}

function createCompilerReceipt({ contract, sourceReceiptBytes, compilerBytes, tinygoRootBytes }) {
	return {
		schemaVersion: 6,
		format: 'wasm-llvm-tinygo-browser-compiler-v6',
		producerId: contract.manifest.producerId,
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
			packageGraph: [...contract.lock.compilerIdentity.requiredPackages],
			compileProtocol: {
				version: contract.manifest.compileProtocol.version,
				format: contract.manifest.compileProtocol.format,
				capabilities: [...contract.manifest.compileProtocol.capabilities]
			},
			compileOutputs: [...contract.manifest.compileProtocol.outputs],
			runtimeProfile: structuredClone(contract.manifest.compileProtocol.runtimeProfile),
			rootArchive: structuredClone(contract.manifest.rootArchive),
			finalization: {
				linker: contract.manifest.finalization.linker,
				optimizer: contract.manifest.finalization.optimizer,
				linkArguments: [
					'objects/0000-program.o',
					'objects/0001-target-c.bc',
					'objects/0002-target-cxx.bc',
					'objects/0003-target-assembly.o',
					'objects/0004-embed.o',
					'-o',
					'program.wasm'
				]
			}
		},
		verification: {
			status: 'passed',
			identityMode: 'upstream-package-graph',
			compilerVersion:
				'tinygo version 0.40.1 linux/amd64 (using go version go1.22 and LLVM version 20.1.1)',
			acceptance: {
				status: 'passed',
				fixture: {
					sourceSha256: contract.acceptance.sourceSha256,
					nativeSources: structuredClone(contract.acceptance.nativeSources),
					embedSha256: contract.acceptance.embedSha256,
					stdinSha256: contract.acceptance.stdinSha256,
					stdoutSha256: contract.acceptance.stdoutSha256
				},
				compile: {
					objects: [
						{
							path: 'objects/0000-program.o',
							bytes: 1024,
							sha256: 'e'.repeat(64)
						},
						{
							path: 'objects/0001-target-c.bc',
							bytes: 128,
							sha256: 'd'.repeat(64)
						},
						{
							path: 'objects/0002-target-cxx.bc',
							bytes: 128,
							sha256: 'b'.repeat(64)
						},
						{
							path: 'objects/0003-target-assembly.o',
							bytes: 128,
							sha256: 'a'.repeat(64)
						},
						{
							path: 'objects/0004-embed.o',
							bytes: 128,
							sha256: 'c'.repeat(64)
						}
					],
					linkPlan: {
						path: 'link-plan.json',
						bytes: 256,
						sha256: 'f'.repeat(64)
					},
					finalWasmSha256: '1'.repeat(64)
				},
				execution: {
					exitCode: 0,
					stdout: contract.acceptance.expectedStdout,
					stdoutSha256: contract.acceptance.stdoutSha256
				}
			}
		},
		assets: [
			{
				path: 'tinygo-compiler.wasm',
				bytes: compilerBytes.length,
				sha256: sha256(compilerBytes)
			},
			{
				path: 'tinygoroot.tar.gz',
				bytes: tinygoRootBytes.length,
				sha256: sha256(tinygoRootBytes)
			}
		]
	};
}

async function createFixtureContract() {
	const checkedIn = await loadTinyGoProducerContract();
	const sourceDir = await createSourceFixture();
	const lock = fixtureLock(checkedIn);
	const manifest = structuredClone(checkedIn.manifest);
	const inputs = producerInputs();
	const identity = await verifyTinyGoSourceIdentity({
		sourceDir,
		lock,
		gitImpl: cleanGit(lock)
	});
	const sourceReceipt = createTinyGoSourceReceipt({ manifest, lock, identity, inputs });
	validateTinyGoSourceReceipt(sourceReceipt, { manifest, lock, inputs });
	return {
		sourceDir,
		manifest,
		lock,
		inputs,
		acceptance: structuredClone(checkedIn.acceptance),
		sourceReceipt
	};
}

test('pins the actual upstream TinyGo compiler, go-llvm, and LLVM identities', async () => {
	const contract = await loadTinyGoProducerContract();
	assert.equal(contract.lock.tinygo.commit, 'db9f1182f5f2a64ea496752899626578d2b313a7');
	assert.equal(contract.lock.goLlvm.commit, 'b8f170971e747fec20a03b25a4490f627140709a');
	assert.deepEqual(
		contract.lock.goLlvm.hostSupportSources.map((entry) => entry.path),
		[
			'IRBindings.cpp',
			'IRBindings.h',
			'SupportBindings.cpp',
			'SupportBindings.h',
			'backports.cpp',
			'backports.h'
		]
	);
	assert.equal(contract.lock.llvm.commit, '670759811adc85df52f410d7306788fabfc6242d');
	assert.deepEqual(contract.manifest.compileProtocol.targetNativeSourcePolicy, {
		cgoFiles: 'program-object-with-source-closure-v6',
		cFiles: 'thinlto-object-set-v6',
		cxxFiles: 'hosted-noeh-libcxx-thinlto-object-set-v6',
		sFiles: 'clang-uppercase-s-wasm-object-set-v4',
		embedFiles: 'generated-object-set-v2'
	});
	assert.deepEqual(contract.manifest.compileProtocol.runtimeProfile, {
		id: 'wasip1-asyncify-precise-o1',
		target: 'wasip1',
		opt: '1',
		gc: 'precise',
		panicStrategy: 'print',
		scheduler: 'asyncify',
		debug: false,
		parallelism: 1
	});
	assert.deepEqual(contract.manifest.rootArchive.requiredPaths, [
		'src',
		'go.env',
		'targets',
		'go.mod',
		'go.sum',
		'lib/clang',
		'lib/wasi-libc/include',
		'lib/wasi-libc/include/c++/v1',
		'runtime'
	]);
	assert.equal(contract.lock.compilerIdentity.entrypoint, 'main.go');
	assert.deepEqual(
		contract.lock.compilerIdentity.requiredPackages,
		contract.manifest.upstreamCompiler.requiredPackages
	);
	assert.equal(contract.manifest.readiness.ready, true);
	assert.equal(contract.manifest.llvm.purpose, 'legacy-emception-worker-only');
	assert.equal(contract.manifest.compileProtocol.version, 6);
	assert.equal(contract.manifest.compileProtocol.format, 'wasm-llvm-tinygo-link-plan-v6');
	assert.equal(
		contract.manifest.rootArchive.runtimeClosureFormat,
		'wasm-llvm-tinygo-runtime-closure-v2'
	);
	assert.deepEqual(contract.manifest.compileProtocol.outputs, ['objects', 'link-plan.json']);
	assert.deepEqual(contract.manifest.compileProtocol.capabilities, [
		'go-embed-objects',
		'target-cgo-c',
		'target-cxx-hosted-noeh',
		'target-clang-assembly',
		'target-cgo-cxxflags',
		'target-cgo-linker-flags'
	]);
	assert.deepEqual(contract.manifest.compileProtocol.targetNativeValidation, {
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
	});
	assert.deepEqual(
		contract.acceptance.nativeSources.map((source) => source.path),
		[
			'fixtures/upstream-language-smoke/cgo.go',
			'fixtures/upstream-language-smoke/helper.c',
			'fixtures/upstream-language-smoke/helper.cpp',
			'fixtures/upstream-language-smoke/helper.S'
		]
	);
	assert.deepEqual(contract.manifest.acceptance.requiredFeatures, [
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
	]);
	assert.equal(
		contract.acceptance.expectedStdout,
		'hello Ada count=2 total=3 semantics=9/9 cgo=5/20 cxxasm=13\n'
	);
});

test('accepts pnpm literal argument separators in source preparation commands', () => {
	assert.deepEqual(
		parsePrepareSourceArgs(['--verify', '--', 'out/source', 'out/source-receipt.json']),
		{
			help: false,
			verify: true,
			sourceDir: path.resolve('out/source'),
			receiptPath: path.resolve('out/source-receipt.json')
		}
	);
});

test('auto-clones TinyGo and initializes its pinned recursive submodules', async () => {
	const contract = await loadTinyGoProducerContract();
	assert.ok(contract.lock.patches.length > 0);
	const root = await mkdtemp(path.join(os.tmpdir(), 'wasm-llvm-tinygo-auto-clone-'));
	tempDirs.push(root);
	const sourceDir = path.join(root, 'source');
	const calls = [];

	const result = await ensurePinnedTinyGoCheckout({
		sourceDir,
		lock: contract.lock,
		execFileImpl: async (...args) => {
			calls.push(args);
			if (args[0] === 'git' && args[1]?.[0] === 'clone') {
				await mkdir(path.join(sourceDir, '.git'), { recursive: true });
			}
			return { stdout: '', stderr: '' };
		}
	});

	assert.deepEqual(result, { cloned: true, sourceDir });
	assert.equal(calls.length, 3);
	assert.deepEqual(calls[0][1], [
		'clone',
		'--filter=blob:none',
		'--no-checkout',
		'--branch',
		contract.lock.tinygo.ref,
		'--depth=1',
		contract.lock.tinygo.repository,
		sourceDir
	]);
	assert.deepEqual(calls[1][1], [
		'-C',
		sourceDir,
		'checkout',
		'--detach',
		contract.lock.tinygo.commit
	]);
	assert.deepEqual(calls[2][1], [
		'-C',
		sourceDir,
		'submodule',
		'update',
		'--init',
		'--recursive',
		'--depth=1'
	]);
});

test('initializes missing submodules in an existing TinyGo checkout', async () => {
	const contract = await loadTinyGoProducerContract();
	const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'wasm-llvm-tinygo-existing-'));
	tempDirs.push(sourceDir);
	await mkdir(path.join(sourceDir, '.git'));
	const calls = [];

	const result = await ensurePinnedTinyGoCheckout({
		sourceDir,
		lock: contract.lock,
		execFileImpl: async (...args) => {
			calls.push(args);
			return { stdout: '', stderr: '' };
		}
	});

	assert.deepEqual(result, { cloned: false, sourceDir });
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0][1], [
		'-C',
		sourceDir,
		'submodule',
		'update',
		'--init',
		'--recursive',
		'--depth=1'
	]);
});

test('verifies source contents and creates a deterministic upstream compiler receipt', async () => {
	const contract = await createFixtureContract();
	assert.equal(contract.sourceReceipt.source.clean, true);
	assert.equal(contract.sourceReceipt.compilerIdentity.sourceFiles.length, 16);
	assert.ok(
		contract.sourceReceipt.compilerIdentity.requiredPackages.includes(
			'github.com/tinygo-org/tinygo/cgo'
		)
	);
	assert.equal(
		contract.sourceReceipt.compilerIdentity.goLlvm.module,
		'tinygo.org/x/go-llvm'
	);
	assert.ok(
		contract.sourceReceipt.compilerIdentity.requiredPackages.includes(
			'github.com/tinygo-org/tinygo/compiler'
		)
	);
});

test('rejects registered patch bytes that drift from the source lock', async () => {
	const lock = structuredClone((await loadTinyGoProducerContract()).lock);
	lock.patches[0].sha256 = '0'.repeat(64);

	await assert.rejects(
		verifyTinyGoLockedPatches(lock, TINYGO_PRODUCER_ROOT),
		/does not match the registered patch SHA-256/u
	);
});

test('rejects go-llvm checksum drift in the pinned upstream go.sum', async () => {
	const contract = await loadTinyGoProducerContract();
	const sourceDir = await createSourceFixture();
	const lock = fixtureLock(contract);
	const goSumWithoutGoModChecksum =
		'tinygo.org/x/go-llvm v0.0.0-20250422114502-b8f170971e74 h1:ovavgTdIBWCH8YWlcfq9gkpoyT1+IxMKSn+Df27QwE8=\n';
	await writeFile(path.join(sourceDir, 'go.sum'), goSumWithoutGoModChecksum);
	const goSumIdentity = lock.compilerIdentity.requiredSources.find(
		(entry) => entry.path === 'go.sum'
	);
	goSumIdentity.sha256 = sha256(goSumWithoutGoModChecksum);
	goSumIdentity.requiredText = ['tinygo.org/x/go-llvm'];

	await assert.rejects(
		verifyTinyGoSourceIdentity({ sourceDir, lock, gitImpl: cleanGit(lock) }),
		/go\.sum is missing the pinned go-llvm go\.mod checksum/u
	);
});

test('rejects a relabeled subset when upstream compiler evidence is absent', async () => {
	const contract = await loadTinyGoProducerContract();
	const sourceDir = await createSourceFixture();
	const lock = fixtureLock(contract);
	const subsetCompiler = `package compiler
import "github.com/tinygo-org/tinygo/loader"
func CompilePackage(
`;
	await writeFile(path.join(sourceDir, 'compiler/compiler.go'), subsetCompiler);
	lock.compilerIdentity.requiredSources.find(
		(entry) => entry.path === 'compiler/compiler.go'
	).sha256 = sha256(subsetCompiler);

	await assert.rejects(
		verifyTinyGoSourceIdentity({ sourceDir, lock, gitImpl: cleanGit(lock) }),
		/missing upstream compiler evidence.*tinygo\.org\/x\/go-llvm/u
	);
});

test('rejects unregistered wasmbridge sources in an otherwise pinned checkout', async () => {
	const contract = await loadTinyGoProducerContract();
	const sourceDir = await createSourceFixture();
	const lock = fixtureLock(contract);
	await assert.rejects(
		verifyTinyGoSourceIdentity({
			sourceDir,
			lock,
			gitImpl: cleanGit(lock, '?? wasmbridge/tinygobackend/backend.go')
		}),
		/unregistered patches or generated sources.*wasmbridge\/tinygobackend/su
	);
});

test('requires source-lock digests and upstream package graph in compiler receipts', async () => {
	const contract = await createFixtureContract();
	const sourceReceiptBytes = Buffer.from(`${JSON.stringify(contract.sourceReceipt, null, 2)}\n`);
	const compilerBytes = wasmWithIdentity(
		contract.manifest.upstreamCompiler.requiredArtifactIdentityStrings
	);
	const tinygoRootBytes = gzipSync('tinygo root fixture');
	const receipt = createCompilerReceipt({
		contract,
		sourceReceiptBytes,
		compilerBytes,
		tinygoRootBytes
	});
	assert.doesNotThrow(() =>
		validateTinyGoCompilerReceipt(receipt, {
			manifest: contract.manifest,
			lock: contract.lock,
			sourceReceipt: contract.sourceReceipt,
			acceptance: contract.acceptance,
			manifestSha256: contract.inputs.manifestSha256,
			sourcesLockSha256: contract.inputs.sourcesLockSha256,
			sourceReceiptSha256: sha256(sourceReceiptBytes)
		})
	);

	const labelOnly = structuredClone(receipt);
	labelOnly.artifactKind = 'compiler';
	assert.throws(
		() =>
			validateTinyGoCompilerReceipt(labelOnly, {
				manifest: contract.manifest,
				lock: contract.lock,
				sourceReceipt: contract.sourceReceipt,
				acceptance: contract.acceptance,
				manifestSha256: contract.inputs.manifestSha256,
				sourcesLockSha256: contract.inputs.sourcesLockSha256,
				sourceReceiptSha256: sha256(sourceReceiptBytes)
			}),
		/artifactKind labels are not compiler identity evidence/u
	);

	const staleLock = structuredClone(receipt);
	staleLock.inputs.sourcesLockSha256 = 'f'.repeat(64);
	assert.throws(
		() =>
			validateTinyGoCompilerReceipt(staleLock, {
				manifest: contract.manifest,
				lock: contract.lock,
				sourceReceipt: contract.sourceReceipt,
				acceptance: contract.acceptance,
				manifestSha256: contract.inputs.manifestSha256,
				sourcesLockSha256: contract.inputs.sourcesLockSha256,
				sourceReceiptSha256: sha256(sourceReceiptBytes)
			}),
		/does not bind the current source lock/u
	);

	const missingAcceptance = structuredClone(receipt);
	delete missingAcceptance.verification.acceptance;
	assert.throws(
		() =>
			validateTinyGoCompilerReceipt(missingAcceptance, {
				manifest: contract.manifest,
				lock: contract.lock,
				sourceReceipt: contract.sourceReceipt,
				acceptance: contract.acceptance,
				manifestSha256: contract.inputs.manifestSha256,
				sourcesLockSha256: contract.inputs.sourcesLockSha256,
				sourceReceiptSha256: sha256(sourceReceiptBytes)
			}),
		/acceptance fixture has not passed/u
	);

	const thinLtoCache = structuredClone(receipt);
	thinLtoCache.build.finalization.linkArguments.push('--thinlto-cache-dir=/tmp/cache');
	assert.throws(
		() =>
			validateTinyGoCompilerReceipt(thinLtoCache, {
				manifest: contract.manifest,
				lock: contract.lock,
				sourceReceipt: contract.sourceReceipt,
				acceptance: contract.acceptance,
				manifestSha256: contract.inputs.manifestSha256,
				sourcesLockSha256: contract.inputs.sourcesLockSha256,
				sourceReceiptSha256: sha256(sourceReceiptBytes)
			}),
		/unsupported argument --thinlto-cache-dir/u
	);
});

test('strictly verifies output hashes and rejects custom compiler identities', async () => {
	const contract = await createFixtureContract();
	contract.manifest.readiness.ready = true;
	const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'wasm-llvm-tinygo-artifacts-'));
	tempDirs.push(artifactDir);
	const sourceReceiptPath = path.join(artifactDir, 'tinygo-source-receipt.json');
	const sourceReceiptBytes = Buffer.from(`${JSON.stringify(contract.sourceReceipt, null, 2)}\n`);
	const compilerBytes = wasmWithIdentity(
		contract.manifest.upstreamCompiler.requiredArtifactIdentityStrings
	);
	const tinygoRootBytes = gzipSync('tinygo root fixture');
	const compilerReceipt = createCompilerReceipt({
		contract,
		sourceReceiptBytes,
		compilerBytes,
		tinygoRootBytes
	});
	await Promise.all([
		writeFile(sourceReceiptPath, sourceReceiptBytes),
		writeFile(path.join(artifactDir, 'tinygo-compiler.wasm'), compilerBytes),
		writeFile(path.join(artifactDir, 'tinygoroot.tar.gz'), tinygoRootBytes),
		writeFile(
			path.join(artifactDir, 'producer-receipt.json'),
			`${JSON.stringify(compilerReceipt, null, 2)}\n`
		)
	]);

	await assert.doesNotReject(
		verifyTinyGoCompilerArtifacts({
			artifactDir,
			sourceReceiptPath,
			contract
		})
	);
	await writeFile(
		path.join(artifactDir, 'tinygo-compiler.wasm'),
		Buffer.alloc(compilerBytes.length, 0)
	);
	await assert.rejects(
		verifyTinyGoCompilerArtifacts({
			artifactDir,
			sourceReceiptPath,
			contract
		}),
		/hash does not match producer receipt/u
	);

	const customCompiler = wasmWithIdentity([
		...contract.manifest.upstreamCompiler.requiredArtifactIdentityStrings,
		'github.com/tinygo-org/tinygo/wasmbridge/tinygobackend'
	]);
	assert.throws(
		() =>
			verifyTinyGoArtifactPayloads({
				compilerBytes: customCompiler,
				tinygoRootBytes,
				manifest: contract.manifest
			}),
		/forbidden custom compiler identity.*wasmbridge/u
	);

	const compilerWithEnvImport = wasmWithIdentity(
		contract.manifest.upstreamCompiler.requiredArtifactIdentityStrings,
		{ importModule: 'env' }
	);
	assert.throws(
		() =>
			verifyTinyGoArtifactPayloads({
				compilerBytes: compilerWithEnvImport,
				tinygoRootBytes,
				manifest: contract.manifest
			}),
		/non-WASI imports: env\.stub/u
	);
});

test('strict artifact verification proceeds past the public readiness gate', async () => {
	const contract = await loadTinyGoProducerContract();
	await assert.rejects(
		verifyTinyGoCompilerArtifacts({
			artifactDir: '/does/not/exist',
			sourceReceiptPath: '/does/not/exist',
			contract
		}),
		/ENOENT|no such file or directory/u
	);
});
