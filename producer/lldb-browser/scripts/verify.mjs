#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import {
	PRODUCER_ROOT,
	REPO_ROOT,
	REQUIRED_ASSETS,
	assertBrowserTransportArtifact,
	getLockedPthreadWorkerSha256,
	loadProducerMetadata,
	readJson,
	sha256,
	validateArtifactManifest,
	validateBuildReceipt,
	verifyLockedInputs
} from './contracts.mjs';
import { EMSCRIPTEN_LINK_FLAGS } from './build.mjs';

export async function verifyArtifactDirectory(artifactDir) {
	const { sourcesLock } = await loadProducerMetadata();
	await verifyLockedInputs(sourcesLock);
	const [receipt, artifactManifest, producerManifestBytes, sourcesLockBytes] = await Promise.all([
		readJson(path.join(artifactDir, 'lldb-browser.receipt.json')),
		readJson(path.join(artifactDir, 'debug-manifest.json')),
		fs.readFile(path.join(PRODUCER_ROOT, 'manifest.json')),
		fs.readFile(path.join(PRODUCER_ROOT, 'sources.lock.json'))
	]);
	validateBuildReceipt(receipt);
	validateArtifactManifest(artifactManifest);

	if (receipt.producer.manifestSha256 !== sha256(producerManifestBytes)) {
		throw new Error('receipt producer manifest hash is stale');
	}
	if (receipt.producer.sourcesLockSha256 !== sha256(sourcesLockBytes)) {
		throw new Error('receipt sources lock hash is stale');
	}
	for (const flag of EMSCRIPTEN_LINK_FLAGS) {
		if (!receipt.build.flags?.includes(flag)) {
			throw new Error(`receipt is missing Emscripten link flag: ${flag}`);
		}
	}

	const assets = {};
	for (const asset of REQUIRED_ASSETS) {
		const bytes = await fs.readFile(path.join(artifactDir, asset));
		const metadata = receipt.assets[asset];
		if (bytes.byteLength !== metadata.size) {
			throw new Error(`size mismatch for ${asset}`);
		}
		const actualHash = sha256(bytes);
		if (actualHash !== metadata.sha256) {
			throw new Error(`SHA-256 mismatch for ${asset}`);
		}
		assets[asset] = bytes;
	}
	if (
		artifactManifest.debugger.lldb.jsSha256 !== receipt.assets['lldb-web-dap.js'].sha256 ||
		artifactManifest.debugger.lldb.wasmSha256 !== receipt.assets['lldb-web-dap.wasm'].sha256 ||
		artifactManifest.debugger.lldb.workerSha256 !==
			receipt.assets['lldb-web-dap.pthread.mjs'].sha256
	) {
		throw new Error('debug manifest and receipt asset hashes differ');
	}
	if (artifactManifest.debugger.lldb.patchesSha256 !== receipt.source.patchesSha256) {
		throw new Error('debug manifest and receipt patch set hashes differ');
	}
	if (
		receipt.assets['lldb-web-dap.pthread.mjs'].sha256 !==
		getLockedPthreadWorkerSha256(sourcesLock)
	) {
		throw new Error('packaged pthread worker differs from its locked overlay');
	}
	await assertBrowserTransportArtifact(
		assets['lldb-web-dap.js'],
		assets['lldb-web-dap.wasm'],
		assets['lldb-web-dap.pthread.mjs']
	);
	return { receipt, artifactManifest };
}

async function main() {
	const argumentsList = process.argv.slice(2).filter((argument) => argument !== '--');
	if (argumentsList.includes('--help') || argumentsList.includes('-h')) {
		console.log(`Usage: node producer/lldb-browser/scripts/verify.mjs [artifact-directory]`);
		return;
	}
	if (argumentsList.length > 1) {
		throw new Error('verify.mjs accepts at most one artifact directory');
	}
	const artifactDir = path.resolve(
		argumentsList[0] ||
			process.env.WASM_LLVM_LLDB_OUT_DIR ||
			path.join(REPO_ROOT, 'artifacts', 'lldb-browser')
	);
	await verifyArtifactDirectory(artifactDir);
	console.log(`Verified LLDB browser artifacts in ${artifactDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
