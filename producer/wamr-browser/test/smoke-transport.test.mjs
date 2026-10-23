import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { packageWamrBrowser } from '../scripts/package.mjs';
import { loadVerifiedTransportSmokeInputs } from '../scripts/smoke-transport.mjs';

async function createFixture(t) {
	const root = await mkdtemp(path.join(tmpdir(), 'wamr-transport-receipt-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const build = path.join(root, 'build');
	const input = path.join(build, 'wasm-idle-output');
	const artifacts = path.join(root, 'artifacts');
	await mkdir(input, { recursive: true });
	await writeFile(path.join(input, 'wamr-debug.js'), [
		'createWamrDebugModule',
		'Module["instantiateWasm"](imports, receiveInstance);',
		'wasm_idle_rsp_read',
		'wasm_idle_rsp_write',
		'wamr-debug.worker.mjs'
	].join('\n'));
	await writeFile(path.join(input, 'wamr-debug.worker.mjs'), [
		'createWamrDebugModule',
		'Module["instantiateWasm"](imports, receiveInstance);',
		'wasmIdleDebugTransportV1',
		'globalThis.onmessage = () => undefined;'
	].join('\n'));
	await writeFile(path.join(input, 'wamr-debug.wasm'), Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
	await packageWamrBrowser({ build, output: artifacts });
	return artifacts;
}

test('transport qualification binds its build provenance and served bytes to the verified package', async t => {
	const artifacts = await createFixture(t);
	const receiptBytes = await readFile(path.join(artifacts, 'producer-receipt.json'));
	const receipt = JSON.parse(receiptBytes);
	const { files, metadata } = await loadVerifiedTransportSmokeInputs(artifacts);
	assert.equal(metadata.producerReceiptSha256, createHash('sha256').update(receiptBytes).digest('hex'));
	assert.deepEqual(metadata.build, {
		wamrRevision: receipt.wamrRevision,
		emscriptenVersion: receipt.emscriptenVersion,
		emsdkRevision: receipt.emsdkRevision,
		provenance: receipt.provenance,
		moduleInstantiation: receipt.moduleInstantiation
	});
	assert.deepEqual(metadata.assets, receipt.assets);
	assert.equal(files.size, 3);
	for (const [name, bytes] of files) {
		const expected = receipt.assets.find(asset => '/' + asset.path === name);
		assert.equal(bytes.byteLength, expected.bytes);
		assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
		await writeFile(path.join(artifacts, name.slice(1)), 'replacement build');
		assert.notDeepEqual(bytes, await readFile(path.join(artifacts, name.slice(1))));
	}
	await writeFile(path.join(artifacts, 'producer-receipt.json'), '{}');
	assert.deepEqual(metadata.build.provenance, receipt.provenance);
});

test('transport qualification rejects a stale producer manifest before starting Chromium', async t => {
	const artifacts = await createFixture(t);
	const receiptPath = path.join(artifacts, 'producer-receipt.json');
	const receipt = JSON.parse(await readFile(receiptPath));
	receipt.provenance.producerManifestSha256 = '0'.repeat(64);
	await writeFile(receiptPath, JSON.stringify(receipt));
	await assert.rejects(loadVerifiedTransportSmokeInputs(artifacts), /stale producerManifestSha256/u);
});

test('transport qualification rejects changed runtime bytes before starting Chromium', async t => {
	const artifacts = await createFixture(t);
	await writeFile(path.join(artifacts, 'wamr-debug.worker.mjs'), 'changed pthread worker');
	await assert.rejects(loadVerifiedTransportSmokeInputs(artifacts), /wamr-debug\.worker\.mjs does not match its producer receipt/u);
});
