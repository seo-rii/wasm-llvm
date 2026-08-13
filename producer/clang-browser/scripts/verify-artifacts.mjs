#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { assertClangdStdinBridge } from './clangd-artifact-contract.mjs';

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

const metadataPath = path.join(artifactDir, 'toolchain.json');
const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
if (!metadata || typeof metadata !== 'object' || !metadata.assets) {
	throw new Error(`Invalid toolchain metadata: ${metadataPath}`);
}

for (const asset of requiredAssets) {
	const assetPath = path.join(artifactDir, asset);
	const bytes = await fs.readFile(assetPath);
	if (bytes.byteLength === 0) throw new Error(`Empty asset: ${asset}`);
	const expectedHash = metadata.assets[asset];
	if (typeof expectedHash !== 'string') {
		throw new Error(`Missing hash for asset: ${asset}`);
	}
	const actualHash = sha256(bytes);
	if (actualHash !== expectedHash) {
		throw new Error(`Hash mismatch for ${asset}: expected ${expectedHash}, got ${actualHash}`);
	}
}

await assertClangdStdinBridge(
	await fs.readFile(path.join(artifactDir, 'clangd', 'clangd.js')),
	await gunzipAsync(await fs.readFile(path.join(artifactDir, 'clangd', 'clangd.wasm.gz')))
);

console.log(`Verified ${requiredAssets.length} Clang producer artifacts in ${artifactDir}`);
