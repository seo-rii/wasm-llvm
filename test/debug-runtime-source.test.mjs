import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeSourceDir = path.join(repoRoot, 'artifacts', 'runtime-source');
const llvmRevision = 'ca7933e47d3a3451d81e72ac174dcb5aa28b59d1';
const wamrRevision = '25bd7eb63e828e4bd242cc9b38d260b4b31c6605';
const reproducibleLldbWasmSha256 =
	'b12f1fa80b00db4f5d8ed472697cc141f1025988dce704401eb25d90089d7665';

function sha256Bytes(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

async function sha256(filePath) {
	return sha256Bytes(await readFile(filePath));
}

test('published runtime source contains a revision-locked LLDB and WAMR bundle', async () => {
	const manifest = JSON.parse(
		await readFile(path.join(runtimeSourceDir, 'runtime-manifest.v2.json'), 'utf8')
	);

	assert.equal(manifest.manifestVersion, 2);
	assert.equal(manifest.compiler.provenance.revision, llvmRevision);
	assert.equal(manifest.debugger.protocolVersion, 1);
	assert.equal(manifest.debugger.transport, 'shared-ring-v1');
	assert.equal(manifest.debugger.lldb.llvmRevision, llvmRevision);
	assert.equal(manifest.debugger.lldb.wasmSha256, reproducibleLldbWasmSha256);
	assert.equal(manifest.debugger.targetRuntime.revision, wamrRevision);

	const [lldbSourcesLockBytes, wamrSourcesLockBytes, wamrProducerManifestBytes] =
		await Promise.all([
			readFile(path.join(repoRoot, 'producer/lldb-browser/sources.lock.json')),
			readFile(path.join(repoRoot, 'producer/wamr-browser/sources.lock.json')),
			readFile(path.join(repoRoot, 'producer/wamr-browser/manifest.json'))
		]);
	const lldbSourcesLock = JSON.parse(lldbSourcesLockBytes);
	const wamrProducerManifest = JSON.parse(wamrProducerManifestBytes);
	assert.equal(
		manifest.debugger.lldb.sourcesLockSha256,
		sha256Bytes(lldbSourcesLockBytes),
		'published LLDB provenance must match the current source lock'
	);
	assert.equal(
		manifest.debugger.lldb.patchesSha256,
		sha256Bytes(lldbSourcesLock.patches.map((entry) => entry.sha256).join('\n')),
		'published LLDB provenance must match the current patch set'
	);
	assert.deepEqual(
		manifest.debugger.targetRuntime.provenance,
		{
			sourcesLockSha256: sha256Bytes(wamrSourcesLockBytes),
			producerManifestSha256: sha256Bytes(wamrProducerManifestBytes),
			patchesSha256: sha256Bytes(
				Object.values(wamrProducerManifest.patches)
					.map((entry) => entry.sha256)
					.join('\n')
			),
			overlaysSha256: sha256Bytes(
				Object.values(wamrProducerManifest.overlays)
					.map((entry) => entry.sha256)
					.join('\n')
			)
		},
		'published WAMR provenance must match the current producer inputs'
	);

	const assets = [
		[manifest.debugger.lldb.js, manifest.debugger.lldb.jsSha256],
		[manifest.debugger.lldb.wasm, manifest.debugger.lldb.wasmSha256],
		[manifest.debugger.lldb.worker, manifest.debugger.lldb.workerSha256],
		[manifest.debugger.targetRuntime.js, manifest.debugger.targetRuntime.jsSha256],
		[manifest.debugger.targetRuntime.wasm, manifest.debugger.targetRuntime.wasmSha256],
		[manifest.debugger.targetRuntime.worker, manifest.debugger.targetRuntime.workerSha256]
	];
	assert.deepEqual(
		assets.map(([asset]) => asset),
		[
			'debug/lldb-web-dap.js',
			'debug/lldb-web-dap.wasm',
			'debug/lldb-web-dap.pthread.mjs',
			'debug/wamr-debug.js',
			'debug/wamr-debug.wasm',
			'debug/wamr-debug.worker.mjs'
		]
	);

	for (const [asset, expectedSha256] of assets) {
		const filePath = path.join(runtimeSourceDir, asset);
		assert.ok((await stat(filePath)).size > 0, `${asset} must not be empty`);
		assert.equal(await sha256(filePath), expectedSha256, `${asset} hash must match the manifest`);
	}
});
