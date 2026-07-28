import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

import { createBuildReceipt } from '../producer/lldb-browser/scripts/contracts.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const llvmRevision = 'ca7933e47d3a3451d81e72ac174dcb5aa28b59d1';
const wamrRevision = '25bd7eb63e828e4bd242cc9b38d260b4b31c6605';
const emsdkRevision = 'd223ae73c6998296e3ab27cf81dc2c2c9fd383de';

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

test('assembles a revision-locked RuntimeManifestV2 from Clang, LLDB, and WAMR', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'wasm-debug-release-'));
	try {
		const clang = path.join(root, 'clang');
		const lldb = path.join(root, 'lldb');
		const wamr = path.join(root, 'wamr');
		const output = path.join(root, 'output');
		await Promise.all([
			mkdir(path.join(clang, 'clangd'), { recursive: true }),
			mkdir(lldb, { recursive: true }),
			mkdir(wamr, { recursive: true })
		]);
		for (const asset of [
			'clang.zip',
			'lld.zip',
			'memfs.zip',
			'sysroot.tar.zip',
			'clangd/clangd.js',
			'clangd/clangd.wasm.gz'
		]) {
			await writeFile(path.join(clang, asset), asset);
		}
		await writeFile(
			path.join(clang, 'toolchain.json'),
			`${JSON.stringify({
				version: 'llvmorg-22.1.8',
				llvmVersion: '22.1.8',
				llvmCommit: llvmRevision,
				resourceDir: '/lib/clang/22',
				compilerRuntimeLibDir: 'lib/clang/22/lib/wasi',
				clangd: {
					stdinBridge: 'emscripten-asyncify',
					patch: 'fixture.patch',
					patchSha256: 'a'.repeat(64)
				},
				assets: {}
			})}\n`
		);

		const lldbJs = Buffer.from('lldb-js');
		const lldbWasm = Buffer.from('lldb-wasm');
		const lldbWorker = Buffer.from('lldb-worker');
		await writeFile(path.join(lldb, 'lldb-web-dap.js'), lldbJs);
		await writeFile(path.join(lldb, 'lldb-web-dap.wasm'), lldbWasm);
		await writeFile(path.join(lldb, 'lldb-web-dap.pthread.mjs'), lldbWorker);
		const validLldbManifest = {
			manifestVersion: 1,
			version: 'llvmorg-22.1.8-lldb-web-1',
			debugger: {
				protocolVersion: 1,
				lldb: {
					js: 'lldb-web-dap.js',
					wasm: 'lldb-web-dap.wasm',
					worker: 'lldb-web-dap.pthread.mjs',
					sha256: sha256(lldbWasm),
					jsSha256: sha256(lldbJs),
					wasmSha256: sha256(lldbWasm),
					workerSha256: sha256(lldbWorker),
					wasmCompression: 'none',
					llvmVersion: '22.1.8',
					llvmRevision,
					patchesSha256: 'b'.repeat(64)
				},
				transport: {
					scheme: 'wasm-messageport',
					contract: 'shared-ring-v1',
					requiresSharedArrayBuffer: true
				},
				capabilities: {
					breakpoints: true,
					stepping: true,
					stackTrace: true,
					locals: true,
					globals: true,
					readMemory: true,
					evaluateExpressions: false,
					dataBreakpoints: false,
					wasmThreads: false
				}
			}
		};
		await writeFile(
			path.join(lldb, 'debug-manifest.json'),
			`${JSON.stringify(validLldbManifest)}\n`
		);
		await writeFile(
			path.join(lldb, 'lldb-browser.receipt.json'),
			`${JSON.stringify(
				createBuildReceipt({
					version: validLldbManifest.version,
					manifestSha256: 'c'.repeat(64),
					sourcesLockSha256: 'd'.repeat(64),
					jsBytes: lldbJs,
					wasmBytes: lldbWasm,
					workerBytes: lldbWorker,
					patchesSha256: validLldbManifest.debugger.lldb.patchesSha256,
					buildFlags: []
				})
			)}\n`
		);

		const wamrJs = Buffer.from(
			[
				'createWamrDebugModule',
				'wasm_idle_rsp_read',
				'wasm_idle_rsp_write',
				'wamr-debug.worker.mjs'
			].join('\n')
		);
		const wamrWasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
		const wamrWorker = Buffer.from(
			['createWamrDebugModule', 'wasmIdleDebugTransportV1', 'onmessage'].join('\n')
		);
		const wamrCompressedWasm = gzipSync(wamrWasm, { level: 9, mtime: 0 });
		await writeFile(path.join(wamr, 'wamr-debug.js'), wamrJs);
		await writeFile(path.join(wamr, 'wamr-debug.wasm'), wamrWasm);
		await writeFile(path.join(wamr, 'wamr-debug.worker.mjs'), wamrWorker);
		await writeFile(path.join(wamr, 'wamr-debug.wasm.gz'), wamrCompressedWasm);
		const wamrSourcesLockBytes = await readFile(
			path.join(repoRoot, 'producer/wamr-browser/sources.lock.json')
		);
		const wamrProducerManifestBytes = await readFile(
			path.join(repoRoot, 'producer/wamr-browser/manifest.json')
		);
		const wamrProducerManifest = JSON.parse(wamrProducerManifestBytes);
		const validWamrReceipt = {
			format: 'wasm-idle-wamr-debug-v1',
			protocolVersion: 1,
			transport: 'shared-ring-v1',
			pthreadTransport: 'pthread-transport-v1',
			wamrRevision,
			emscriptenVersion: '6.0.0',
			emsdkRevision,
			provenance: {
				sourcesLockSha256: sha256(wamrSourcesLockBytes),
				producerManifestSha256: sha256(wamrProducerManifestBytes),
				patchesSha256: sha256(
					Object.values(wamrProducerManifest.patches)
						.map((entry) => entry.sha256)
						.join('\n')
				),
				overlaysSha256: sha256(
					Object.values(wamrProducerManifest.overlays)
						.map((entry) => entry.sha256)
						.join('\n')
				)
			},
			assets: [
				{
					path: 'wamr-debug.js',
					bytes: wamrJs.byteLength,
					sha256: sha256(wamrJs)
				},
				{
					path: 'wamr-debug.wasm',
					bytes: wamrWasm.byteLength,
					sha256: sha256(wamrWasm)
				},
				{
					path: 'wamr-debug.worker.mjs',
					bytes: wamrWorker.byteLength,
					sha256: sha256(wamrWorker)
				},
				{
					path: 'wamr-debug.wasm.gz',
					bytes: wamrCompressedWasm.byteLength,
					sha256: sha256(wamrCompressedWasm),
					uncompressedBytes: wamrWasm.byteLength,
					uncompressedSha256: sha256(wamrWasm)
				}
			]
		};
		await writeFile(
			path.join(wamr, 'producer-receipt.json'),
			`${JSON.stringify(validWamrReceipt)}\n`
		);

		const releaseEnvironment = {
			...process.env,
			WASM_LLVM_CLANG_ARTIFACT_DIR: clang,
			WASM_LLVM_LLDB_ARTIFACT_DIR: lldb,
			WASM_LLVM_WAMR_ARTIFACT_DIR: wamr
		};
		await execFileAsync(
			process.execPath,
			['producer/clang-browser/scripts/prepare-release.mjs'],
			{
				cwd: repoRoot,
				env: {
					...releaseEnvironment,
					WASM_LLVM_CLANG_RELEASE_DIR: output
				}
			}
		);
		const manifest = JSON.parse(
			await readFile(path.join(output, 'runtime-manifest.v2.json'), 'utf8')
		);
		assert.equal(manifest.manifestVersion, 2);
		assert.equal(manifest.compiler.provenance.revision, llvmRevision);
		assert.equal(manifest.debugger.lldb.llvmRevision, llvmRevision);
		assert.equal(manifest.debugger.lldb.sourcesLockSha256, 'd'.repeat(64));
		assert.equal(manifest.debugger.targetRuntime.revision, wamrRevision);
		assert.deepEqual(manifest.debugger.targetRuntime.provenance, validWamrReceipt.provenance);
		assert.equal(manifest.debugger.transport, 'shared-ring-v1');
		assert.equal(manifest.debugger.lldb.worker, 'debug/lldb-web-dap.pthread.mjs');
		assert.equal(manifest.debugger.targetRuntime.worker, 'debug/wamr-debug.worker.mjs');
		assert.deepEqual(await readFile(path.join(output, 'debug/wamr-debug.wasm')), wamrWasm);

		await writeFile(path.join(wamr, 'wamr-debug.wasm'), 'corrupt');
		await assert.rejects(
			execFileAsync(
				process.execPath,
				['producer/clang-browser/scripts/prepare-release.mjs'],
				{
					cwd: repoRoot,
					env: {
						...releaseEnvironment,
						WASM_LLVM_CLANG_RELEASE_DIR: path.join(root, 'corrupt-output')
					}
				}
			),
			/does not match its producer receipt/u
		);
		await writeFile(path.join(wamr, 'wamr-debug.wasm'), wamrWasm);

		const contractCases = [
			{
				name: 'missing LLDB manifest version',
				file: path.join(lldb, 'debug-manifest.json'),
				base: validLldbManifest,
				mutate(value) {
					delete value.manifestVersion;
				},
				error: /Invalid LLDB artifact manifest/u
			},
			{
				name: 'missing LLDB protocol version',
				file: path.join(lldb, 'debug-manifest.json'),
				base: validLldbManifest,
				mutate(value) {
					delete value.debugger.protocolVersion;
				},
				error: /Invalid LLDB artifact manifest/u
			},
			{
				name: 'tampered LLDB asset path',
				file: path.join(lldb, 'debug-manifest.json'),
				base: validLldbManifest,
				mutate(value) {
					value.debugger.lldb.worker = '../lldb-worker.mjs';
				},
				error: /Invalid LLDB artifact manifest/u
			},
			{
				name: 'tampered LLDB compression contract',
				file: path.join(lldb, 'debug-manifest.json'),
				base: validLldbManifest,
				mutate(value) {
					value.debugger.lldb.wasmCompression = 'gzip';
				},
				error: /Invalid LLDB artifact manifest/u
			},
			{
				name: 'tampered LLDB pthread requirement',
				file: path.join(lldb, 'debug-manifest.json'),
				base: validLldbManifest,
				mutate(value) {
					value.debugger.transport.requiresSharedArrayBuffer = false;
				},
				error: /Invalid LLDB artifact manifest/u
			},
			{
				name: 'tampered LLDB revision',
				file: path.join(lldb, 'debug-manifest.json'),
				base: validLldbManifest,
				mutate(value) {
					value.debugger.lldb.llvmRevision = '0'.repeat(40);
				},
				error: /Invalid LLDB artifact manifest/u
			},
			{
				name: 'tampered WAMR protocol version',
				file: path.join(wamr, 'producer-receipt.json'),
				base: validWamrReceipt,
				mutate(value) {
					value.protocolVersion = 2;
				},
				error: /incompatible protocol contract/u
			},
			{
				name: 'missing WAMR pthread contract',
				file: path.join(wamr, 'producer-receipt.json'),
				base: validWamrReceipt,
				mutate(value) {
					delete value.pthreadTransport;
				},
				error: /incompatible protocol contract/u
			},
			{
				name: 'tampered WAMR revision',
				file: path.join(wamr, 'producer-receipt.json'),
				base: validWamrReceipt,
				mutate(value) {
					value.wamrRevision = '0'.repeat(40);
				},
				error: /pinned source revisions/u
			},
			{
				name: 'tampered Emscripten revision',
				file: path.join(wamr, 'producer-receipt.json'),
				base: validWamrReceipt,
				mutate(value) {
					value.emsdkRevision = '0'.repeat(40);
				},
				error: /pinned source revisions/u
			},
			{
				name: 'tampered WAMR asset path',
				file: path.join(wamr, 'producer-receipt.json'),
				base: validWamrReceipt,
				mutate(value) {
					value.assets[2].path = '../wamr-debug.worker.mjs';
				},
				error: /invalid or duplicate asset/u
			},
			{
				name: 'tampered WAMR compression metadata',
				file: path.join(wamr, 'producer-receipt.json'),
				base: validWamrReceipt,
				mutate(value) {
					value.assets[3].uncompressedSha256 = '0'.repeat(64);
				},
				error: /runtime asset or compression data/u
			}
		];
		for (const [index, contractCase] of contractCases.entries()) {
			const tampered = structuredClone(contractCase.base);
			contractCase.mutate(tampered);
			await writeFile(contractCase.file, `${JSON.stringify(tampered)}\n`);
			await assert.rejects(
				execFileAsync(
					process.execPath,
					['producer/clang-browser/scripts/prepare-release.mjs'],
					{
						cwd: repoRoot,
						env: {
							...releaseEnvironment,
							WASM_LLVM_CLANG_RELEASE_DIR: path.join(root, `contract-output-${index}`)
						}
					}
				),
				contractCase.error,
				contractCase.name
			);
			await writeFile(contractCase.file, `${JSON.stringify(contractCase.base)}\n`);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
