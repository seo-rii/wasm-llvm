#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

import { PACKAGED_PTHREAD_WORKER } from './build.mjs';
import { isMain, parseArguments, producerRoot } from './shared.mjs';

const gunzipAsync = promisify(gunzip);
const DEFAULT_COMPRESSED_SIZE_BUDGET = 20 * 1024 * 1024;
export const WAMR_RUNTIME_ASSETS = Object.freeze([
	'wamr-debug.js',
	'wamr-debug.wasm',
	PACKAGED_PTHREAD_WORKER,
	'wamr-debug.wasm.gz'
]);

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

export async function verifyWamrBrowser({ artifacts, sizeBudget }) {
	if (!artifacts) throw new Error('--artifacts is required');
	artifacts = path.resolve(artifacts);
	const receipt = JSON.parse(
		await readFile(path.join(artifacts, 'producer-receipt.json'), 'utf8')
	);
	if (receipt.format !== 'wasm-idle-wamr-debug-v1') {
		throw new Error('unexpected WAMR debugger receipt format');
	}
	if (receipt.transport !== 'shared-ring-v1') {
		throw new Error('WAMR debugger receipt has an unsupported transport');
	}
	if (receipt.pthreadTransport !== 'pthread-transport-v1') {
		throw new Error('WAMR debugger receipt has an unsupported pthread transport');
	}
	const [sourcesLockBytes, producerManifestBytes] = await Promise.all([
		readFile(path.join(producerRoot, 'sources.lock.json')),
		readFile(path.join(producerRoot, 'manifest.json'))
	]);
	const producerManifest = JSON.parse(producerManifestBytes);
	const expectedProvenance = {
		sourcesLockSha256: sha256(sourcesLockBytes),
		producerManifestSha256: sha256(producerManifestBytes),
		patchesSha256: sha256(
			Object.values(producerManifest.patches)
				.map((entry) => entry.sha256)
				.join('\n')
		),
		overlaysSha256: sha256(
			Object.values(producerManifest.overlays)
				.map((entry) => entry.sha256)
				.join('\n')
		)
	};
	for (const [name, expected] of Object.entries(expectedProvenance)) {
		if (receipt.provenance?.[name] !== expected) {
			throw new Error(`WAMR debugger receipt has stale ${name} provenance`);
		}
	}
	const receiptAssetPaths = new Set(receipt.assets.map((asset) => asset.path));
	if (receiptAssetPaths.size !== receipt.assets.length) {
		throw new Error('WAMR debugger receipt contains duplicate asset metadata');
	}
	for (const asset of WAMR_RUNTIME_ASSETS) {
		if (!receiptAssetPaths.has(asset)) {
			throw new Error(`WAMR debugger receipt is missing ${asset}`);
		}
	}
	if (receiptAssetPaths.size !== WAMR_RUNTIME_ASSETS.length) {
		throw new Error('WAMR debugger receipt contains unexpected asset metadata');
	}
	for (const asset of receipt.assets) {
		const bytes = await readFile(path.join(artifacts, asset.path));
		if (bytes.byteLength !== asset.bytes || sha256(bytes) !== asset.sha256) {
			throw new Error(`${asset.path} does not match its producer receipt`);
		}
	}

	const compressed = await readFile(path.join(artifacts, 'wamr-debug.wasm.gz'));
	const uncompressed = await readFile(path.join(artifacts, 'wamr-debug.wasm'));
	const budget = sizeBudget ? Number(sizeBudget) : DEFAULT_COMPRESSED_SIZE_BUDGET;
	if (compressed.byteLength > budget) {
		throw new Error(`wamr-debug.wasm.gz exceeds its ${budget}-byte compressed size budget`);
	}
	const wasm = await gunzipAsync(compressed);
	await WebAssembly.compile(uncompressed);
	if (!wasm.equals(uncompressed)) {
		throw new Error('compressed and uncompressed WAMR Wasm assets differ');
	}
	const wasmReceipt = receipt.assets.find((asset) => asset.path.endsWith('.wasm.gz'));
	if (
		wasm.byteLength !== wasmReceipt.uncompressedBytes ||
		sha256(wasm) !== wasmReceipt.uncompressedSha256
	) {
		throw new Error('uncompressed WAMR Wasm does not match its producer receipt');
	}
	const loader = await readFile(path.join(artifacts, 'wamr-debug.js'), 'utf8');
	for (const marker of [
		'createWamrDebugModule',
		'wasm_idle_rsp_read',
		'wasm_idle_rsp_write',
		PACKAGED_PTHREAD_WORKER
	]) {
		if (!loader.includes(marker)) throw new Error(`wamr-debug.js is missing ${marker}`);
	}
	const worker = await readFile(path.join(artifacts, PACKAGED_PTHREAD_WORKER), 'utf8');
	for (const marker of ['createWamrDebugModule', 'wasmIdleDebugTransportV1', 'onmessage']) {
		if (!worker.includes(marker)) {
			throw new Error(`${PACKAGED_PTHREAD_WORKER} is missing ${marker}`);
		}
	}
	console.log(`Verified WAMR browser debugger in ${artifacts}`);
	return receipt;
}

if (isMain(import.meta.url)) {
	await verifyWamrBrowser(parseArguments(process.argv.slice(2)));
}
