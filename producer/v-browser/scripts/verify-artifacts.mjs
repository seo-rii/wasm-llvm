#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, configure } from '@zip.js/zip.js';

import { requireTarFiles } from '../../../scripts/lib/tar.mjs';

configure({ useWebWorkers: false });

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const producerRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(producerRoot, '..', '..');
export const V_ARTIFACTS = Object.freeze({
	'v.zip': 'v',
	'vroot.tar.zip': 'vroot.tar',
	'c-sysroot.tar.zip': 'c-sysroot.tar'
});
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Read the only entry of a deterministic single-file zip artifact. */
export async function readSingleEntry(artifactDir, asset, expectedName) {
	const bytes = await readFile(path.join(artifactDir, asset));
	const reader = new ZipReader(new Uint8ArrayReader(bytes));
	try {
		const entries = await reader.getEntries();
		if (entries.length !== 1 || entries[0].directory || entries[0].filename !== expectedName) {
			throw new Error(`${asset} must contain only ${expectedName}`);
		}
		return entries[0].getData(new Uint8ArrayWriter(), { checkSignature: true });
	} finally {
		await reader.close();
	}
}

export async function verify(artifactDir) {
	const receipt = JSON.parse(await readFile(path.join(artifactDir, 'toolchain.json'), 'utf8'));
	const manifestBytes = await readFile(path.join(producerRoot, 'manifest.json'));
	if (receipt.producer?.manifestSha256 !== sha256(manifestBytes)) {
		throw new Error('toolchain.json was produced from a different producer manifest');
	}
	const expectedFiles = [...Object.keys(V_ARTIFACTS), 'toolchain.json'].sort();
	const actualFiles = (await readdir(artifactDir)).sort();
	if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
		throw new Error(`V artifact directory must contain exactly ${expectedFiles.join(', ')}`);
	}
	const entries = {};
	for (const [asset, entry] of Object.entries(V_ARTIFACTS)) {
		const bytes = await readFile(path.join(artifactDir, asset));
		const expected = receipt.assets?.[asset];
		if (!expected || expected.bytes !== bytes.length || expected.sha256 !== sha256(bytes)) {
			throw new Error(`${asset} does not match toolchain.json`);
		}
		entries[asset] = await readSingleEntry(artifactDir, asset, entry);
	}
	const compiler = entries['v.zip'];
	if (sha256(compiler) !== receipt.acceptance?.compiler?.sha256) {
		throw new Error('the accepted compiler differs from v.zip');
	}
	await WebAssembly.compile(compiler);
	requireTarFiles(entries['vroot.tar.zip'],
		['./v/vlib/builtin/builtin.v', './v/vlib/os/os.v', './v/LICENSE'], 'vroot.tar');
	requireTarFiles(entries['c-sysroot.tar.zip'], [
		'./include/wasm32-wasi/stdio.h',
		'./include/v-wasi/v_wasi_compat.h',
		'./lib/wasm32-wasi/libc.a',
		'./lib/wasm32-wasi/libvwasi.a',
		'./lib/clang/22/lib/wasi/libclang_rt.builtins-wasm32.a'
	], 'c-sysroot.tar');
	const results = receipt.acceptance?.results || {};
	if (
		results.rejectedInvalidSource !== true ||
		results.translatedSource !== true ||
		results.stdinStdout !== true ||
		![receipt.acceptance?.compiler, results.generatedC, results.program].every((asset) =>
			Number.isSafeInteger(asset?.bytes) && asset.bytes > 0 && /^[0-9a-f]{64}$/.test(asset.sha256))
	) {
		throw new Error('toolchain.json lacks a passing compile/run acceptance');
	}
	if (receipt.acceptance.compiler.bytes !== compiler.length)
		throw new Error('accepted compiler size differs from v.zip');
	for (const name of ['program.v', 'invalid.v']) {
		const fixture = `fixtures/${name}`;
		if (receipt.acceptance.fixtures?.[fixture] !== sha256(await readFile(path.join(producerRoot, fixture))))
			throw new Error(`acceptance fixture differs from ${fixture}`);
	}
	return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const artifactDir = path.resolve(
		process.env.WASM_LLVM_V_ARTIFACT_DIR || path.join(repoRoot, 'artifacts', 'v-browser')
	);
	await verify(artifactDir);
	console.log(`Verified V producer artifacts in ${artifactDir}`);
}
