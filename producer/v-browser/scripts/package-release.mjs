#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { V_ARTIFACTS, verify } from './verify-artifacts.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE_DIR = process.env.WASM_LLVM_V_ARTIFACT_DIR
	? path.resolve(process.env.WASM_LLVM_V_ARTIFACT_DIR)
	: path.resolve(REPO_ROOT, 'artifacts', 'v-browser');
const TARGET_DIR = path.resolve(
	process.env.WASM_LLVM_V_RELEASE_DIR || process.argv[2] || path.join(REPO_ROOT, 'out', 'v-browser')
);

const toolchain = await verify(SOURCE_DIR);
await fs.mkdir(TARGET_DIR, { recursive: true });
const buildAssets = [];
for (const asset of Object.keys(V_ARTIFACTS)) {
	const bytes = await fs.readFile(path.resolve(SOURCE_DIR, asset));
	await fs.writeFile(path.resolve(TARGET_DIR, asset), bytes);
	buildAssets.push({
		asset,
		size: bytes.byteLength,
		sha256: crypto.createHash('sha256').update(bytes).digest('hex')
	});
}

const profile = {
	name: 'v-wasi-clang',
	version: 1,
	vVersion: toolchain.vVersion,
	vCommit: toolchain.vCommit,
	frontendTarget: 'wasm32-wasi',
	backend: 'wasm-llvm-clang',
	unsupported: ['os.execute', 'processes', 'threads', 'network', 'C interop beyond wasi-libc']
};
const manifest = {
	manifestVersion: 1,
	version: toolchain.version,
	frontend: { asset: 'v.zip', argv0: 'v' },
	rootfs: { asset: 'vroot.tar.zip' },
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
console.log(`Prepared the V deployment bundle in ${TARGET_DIR}`);
