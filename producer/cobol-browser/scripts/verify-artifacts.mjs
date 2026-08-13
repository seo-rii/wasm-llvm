#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, configure } from '@zip.js/zip.js';

configure({ useWebWorkers: false });

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const artifactDir = path.resolve(
	process.env.WASM_LLVM_COBOL_ARTIFACT_DIR || path.join(repoRoot, 'artifacts', 'cobol-browser')
);
const receipt = JSON.parse(await readFile(path.join(artifactDir, 'toolchain.json'), 'utf8'));

async function readSingleEntry(asset, expectedName) {
	const bytes = await readFile(path.join(artifactDir, asset));
	const expected = receipt.assets?.[asset];
	if (!expected || expected.bytes !== bytes.length) {
		throw new Error(`${asset} size does not match toolchain.json`);
	}
	const actualHash = createHash('sha256').update(bytes).digest('hex');
	if (actualHash !== expected.sha256) throw new Error(`${asset} hash does not match toolchain.json`);

	const reader = new ZipReader(new Uint8ArrayReader(bytes));
	try {
		const entries = (await reader.getEntries()).filter(
			(entry) => !entry.directory && 'getData' in entry
		);
		if (entries.length !== 1 || entries[0].filename !== expectedName) {
			throw new Error(`${asset} must contain only ${expectedName}`);
		}
		return entries[0].getData(new Uint8ArrayWriter());
	} finally {
		await reader.close();
	}
}

const cobc = await readSingleEntry('cobc.zip', 'cobc');
await WebAssembly.compile(cobc);
for (const [asset, entry] of [
	['rootfs.tar.zip', 'rootfs.tar'],
	['c-sysroot.tar.zip', 'c-sysroot.tar']
]) {
	const tar = await readSingleEntry(asset, entry);
	if (tar.length < 1024) throw new Error(`${asset} contains an empty tar archive`);
}

console.log(`Verified COBOL producer artifacts in ${artifactDir}`);
