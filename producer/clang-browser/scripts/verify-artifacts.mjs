#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { assertClangdStdinBridge } from './clangd-artifact-contract.mjs';
import {
	CLANGD_HEADER_ASSET,
	validateClangdHeaderMetadata,
	verifyClangdHeaderAsset
} from './clangd-header-asset-contract.mjs';

const gunzipAsync = promisify(gunzip);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const artifactDir = path.resolve(
	process.env.WASM_LLVM_CLANG_ARTIFACT_DIR || path.join(repoRoot, 'artifacts', 'clang-browser')
);
const requiredAssets = [
	'clang.zip',
	'lld.zip',
	'memfs.zip',
	'sysroot.tar.zip',
	'clangd/clangd.js',
	'clangd/clangd.wasm.gz'
];

function sha256(bytes) {
	return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function verifyClangArtifacts(directory = artifactDir) {
	const metadataPath = path.join(directory, 'toolchain.json');
	const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
	if (
		!metadata ||
		typeof metadata !== 'object' ||
		!metadata.assets ||
		typeof metadata.assets !== 'object' ||
		Array.isArray(metadata.assets)
	) {
		throw new Error(`Invalid toolchain metadata: ${metadataPath}`);
	}
	const assets = [...requiredAssets];
	if (metadata.clangd?.headers !== undefined) {
		validateClangdHeaderMetadata(metadata.clangd.headers);
		if (metadata.clangd.headers.resourceDir !== metadata.resourceDir)
			throw new Error('clangd header resource directory does not match the toolchain');
		assets.push(CLANGD_HEADER_ASSET);
	}
	if (
		Object.keys(metadata.assets).length !== assets.length ||
		assets.some((asset) => !Object.hasOwn(metadata.assets, asset))
	)
		throw new Error(
			'Toolchain metadata does not describe the complete Clang producer asset set'
		);

	for (const asset of assets) {
		const assetPath = path.join(directory, asset);
		const bytes = await fs.readFile(assetPath);
		if (bytes.byteLength === 0) throw new Error(`Empty asset: ${asset}`);
		const expectedHash = metadata.assets[asset];
		if (typeof expectedHash !== 'string') {
			throw new Error(`Missing hash for asset: ${asset}`);
		}
		const actualHash = sha256(bytes);
		if (actualHash !== expectedHash) {
			throw new Error(
				`Hash mismatch for ${asset}: expected ${expectedHash}, got ${actualHash}`
			);
		}
	}

	await assertClangdStdinBridge(
		await fs.readFile(path.join(directory, 'clangd', 'clangd.js')),
		await gunzipAsync(await fs.readFile(path.join(directory, 'clangd', 'clangd.wasm.gz')))
	);
	if (metadata.clangd?.headers !== undefined)
		verifyClangdHeaderAsset(
			await fs.readFile(path.join(directory, CLANGD_HEADER_ASSET)),
			metadata.clangd.headers
		);
	return { assets: assets.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const result = await verifyClangArtifacts();
	console.log(`Verified ${result.assets} Clang producer artifacts in ${artifactDir}`);
}
