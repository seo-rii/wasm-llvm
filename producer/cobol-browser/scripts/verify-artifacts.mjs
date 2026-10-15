#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, configure } from '@zip.js/zip.js';

import { requireTarFiles } from '../../../scripts/lib/tar.mjs';

configure({ useWebWorkers: false });

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
async function readSingleEntry(artifactDir, receipt, asset, expectedName) {
	const bytes = await readFile(path.join(artifactDir, asset));
	const expected = receipt.assets?.[asset];
	if (!expected || expected.bytes !== bytes.length) {
		throw new Error(`${asset} size does not match toolchain.json`);
	}
	const actualHash = createHash('sha256').update(bytes).digest('hex');
	if (actualHash !== expected.sha256) throw new Error(`${asset} hash does not match toolchain.json`);

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

export const REQUIRED_TAR_FILES = Object.freeze({
 'rootfs.tar.zip': [
  'include/gmp.h', 'include/libcob.h', 'include/libcob/common.h',
  'lib/libcob.a', 'lib/libcobwasi.a', 'lib/libgmp.a', 'lib/libsetjmp.a',
  'share/gnucobol/config/default.conf', 'share/gnucobol/copy/screenio.cpy'
 ],
 'c-sysroot.tar.zip': [
  'include/wasm32-wasi/stdio.h', 'lib/wasm32-wasi/crt1.o', 'lib/wasm32-wasi/libc.a',
  'lib/clang/22/lib/wasi/libclang_rt.builtins-wasm32.a'
 ]
});

export async function verify(artifactDir) {
 const receipt = JSON.parse(await readFile(path.join(artifactDir, 'toolchain.json'), 'utf8'));
 const cobc = await readSingleEntry(artifactDir, receipt, 'cobc.zip', 'cobc');
 await WebAssembly.compile(cobc);
 for (const [asset, required] of Object.entries(REQUIRED_TAR_FILES)) {
  const tar = await readSingleEntry(artifactDir, receipt, asset, asset.slice(0, -4));
  requireTarFiles(tar, required, asset);
 }
 return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const artifactDir = path.resolve(
  process.env.WASM_LLVM_COBOL_ARTIFACT_DIR || path.join(repoRoot, 'artifacts', 'cobol-browser')
 );
 await verify(artifactDir);
 console.log(`Verified COBOL producer artifacts in ${artifactDir}`);
}
