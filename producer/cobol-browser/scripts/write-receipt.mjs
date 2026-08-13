#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const producerRoot = path.resolve(scriptDir, '..');
const [outputDir, gnucobolVersion, gmpVersion, wasiSdkVersion, frontendLlvmVersion] =
	process.argv.slice(2);

if (!outputDir || !gnucobolVersion || !gmpVersion || !wasiSdkVersion || !frontendLlvmVersion) {
	throw new Error(
		'Usage: write-receipt.mjs OUTPUT_DIR GNUCOBOL_VERSION GMP_VERSION WASI_SDK_VERSION LLVM_VERSION'
	);
}

const manifestPath = path.join(producerRoot, 'manifest.json');
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const assets = {};
for (const asset of ['cobc.zip', 'rootfs.tar.zip', 'c-sysroot.tar.zip']) {
	const assetPath = path.join(outputDir, asset);
	const bytes = await readFile(assetPath);
	assets[asset] = {
		bytes: (await stat(assetPath)).size,
		sha256: createHash('sha256').update(bytes).digest('hex')
	};
}

const receipt = {
	version: `gnucobol-${gnucobolVersion}-wasi-preview1-v1`,
	producer: {
		id: manifest.producerId,
		manifest: 'producer/cobol-browser/manifest.json',
		manifestSha256: createHash('sha256').update(manifestBytes).digest('hex')
	},
	gnucobolVersion,
	gmpVersion,
	wasiSdkVersion,
	frontendLlvmVersion,
	frontendTarget: 'wasm32-wasi',
	backend: 'wasm-llvm-clang',
	assets
};

await writeFile(path.join(outputDir, 'toolchain.json'), `${JSON.stringify(receipt, null, 2)}\n`);
