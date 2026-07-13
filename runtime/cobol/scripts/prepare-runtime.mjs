#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE_DIR = process.env.WASM_COBOL_RUNTIME_SOURCE_DIR
	? path.resolve(process.env.WASM_COBOL_RUNTIME_SOURCE_DIR)
	: path.resolve(REPO_ROOT, 'artifacts', 'cobol-runtime-source');
const TARGET_DIR = path.resolve(REPO_ROOT, 'dist', 'runtime', 'cobol', 'assets');
const assets = ['cobc.zip', 'rootfs.tar.zip', 'c-sysroot.tar.zip'];

await fs.mkdir(TARGET_DIR, { recursive: true });
const toolchain = JSON.parse(await fs.readFile(path.resolve(SOURCE_DIR, 'toolchain.json'), 'utf8'));
const buildAssets = [];
for (const asset of assets) {
	const bytes = await fs.readFile(path.resolve(SOURCE_DIR, asset));
	await fs.writeFile(path.resolve(TARGET_DIR, asset), bytes);
	buildAssets.push({
		asset,
		size: bytes.byteLength,
		sha256: crypto.createHash('sha256').update(bytes).digest('hex')
	});
}

const profile = {
	name: 'gnucobol-wasi-clang',
	version: 1,
	gnucobolVersion: '3.2',
	gmpVersion: '6.3.0',
	frontendTarget: 'wasm32-wasi',
	backend: 'wasm-llvm-clang',
	unsupported: ['dynamic CALL', 'CALL SYSTEM', 'fork', 'SCREEN SECTION', 'indexed I/O']
};
const manifest = {
	manifestVersion: 1,
	version: toolchain.version,
	frontend: { asset: 'cobc.zip', argv0: 'cobc' },
	rootfs: { asset: 'rootfs.tar.zip' },
	cSysroot: { asset: 'c-sysroot.tar.zip' },
	profile
};
await fs.writeFile(
	path.resolve(TARGET_DIR, 'runtime-manifest.v1.json'),
	JSON.stringify(manifest, null, 2) + '\n'
);
await fs.writeFile(
	path.resolve(TARGET_DIR, 'runtime-build.json'),
	JSON.stringify({ toolchain, assets: buildAssets }, null, 2) + '\n'
);
console.log(`Prepared wasm-cobol runtime assets in ${TARGET_DIR}`);
