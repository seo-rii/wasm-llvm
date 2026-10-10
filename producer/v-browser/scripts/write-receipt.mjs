#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { V_ARTIFACTS } from './verify-artifacts.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const producerRoot = path.resolve(scriptDir, '..');
const [outputDir, vVersion, wasiSdkVersion, frontendLlvmVersion, acceptancePath] =
	process.argv.slice(2);

if (!outputDir || !vVersion || !wasiSdkVersion || !frontendLlvmVersion || !acceptancePath) {
	throw new Error(
		'Usage: write-receipt.mjs OUTPUT_DIR V_VERSION WASI_SDK_VERSION LLVM_VERSION ACCEPTANCE_JSON'
	);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = await readFile(path.join(producerRoot, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const assets = {};
for (const asset of Object.keys(V_ARTIFACTS)) {
	const bytes = await readFile(path.join(outputDir, asset));
	assets[asset] = { bytes: bytes.length, sha256: sha256(bytes) };
}
const compat = {};
for (const name of [
	'compat/v-wasi-compat.c',
	'compat/include/v_wasi_compat.h',
	'compat/include/termios.h',
	'compat/include/sys/ptrace.h',
	'compat/include/sys/wait.h'
]) {
	compat[name] = sha256(await readFile(path.join(producerRoot, name)));
}

const receipt = {
	version: `v-${vVersion}-wasi-preview1-v1`,
	producer: {
		id: manifest.producerId,
		manifest: 'producer/v-browser/manifest.json',
		manifestSha256: sha256(manifestBytes)
	},
	vVersion,
	vCommit: manifest.sources.v.commit,
	vcCommit: manifest.sources.vc.commit,
	wasiSdkVersion,
	frontendLlvmVersion,
	frontendTarget: 'wasm32-wasi',
	backend: 'wasm-llvm-clang',
	compat,
	assets,
	acceptance: JSON.parse(await readFile(acceptancePath, 'utf8'))
};

await writeFile(path.join(outputDir, 'toolchain.json'), `${JSON.stringify(receipt, null, 2)}\n`);
