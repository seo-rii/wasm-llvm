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
	'4d355af4301df8955b91e5cd0d78f9845c6d81e6508982e7e9beae4a3f778711';

async function sha256(filePath) {
	const bytes = await readFile(filePath);
	return createHash('sha256').update(bytes).digest('hex');
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
