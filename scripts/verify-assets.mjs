#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeSourceDir = path.resolve(repoRoot, 'artifacts', 'runtime-source');
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

const metadataPath = path.join(runtimeSourceDir, 'toolchain.json');
const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
if (!metadata || typeof metadata !== 'object' || !metadata.assets) {
	throw new Error(`Invalid toolchain metadata: ${metadataPath}`);
}

for (const asset of requiredAssets) {
	const assetPath = path.join(runtimeSourceDir, asset);
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

console.log(`Verified ${requiredAssets.length} wasm-llvm runtime assets in ${runtimeSourceDir}`);
