#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

const gunzipAsync = promisify(gunzip);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const producerRoot = path.resolve(scriptDir, '..');
const artifactDir = path.join(producerRoot, 'artifacts');
const receipt = JSON.parse(
	await readFile(path.join(artifactDir, 'producer-receipt.json'), 'utf8')
);

for (const entry of receipt.assets) {
	const bytes = await readFile(path.join(artifactDir, entry.path));
	if (bytes.length !== entry.bytes) throw new Error(`${entry.path} size does not match receipt`);
	const actualHash = createHash('sha256').update(bytes).digest('hex');
	if (actualHash !== entry.sha256) throw new Error(`${entry.path} hash does not match receipt`);
}

await WebAssembly.compile(await gunzipAsync(await readFile(path.join(artifactDir, 'lld.wasm.gz'))));
const loader = await readFile(path.join(artifactDir, 'lld.js'), 'utf8');
if (!loader.includes('lld.wasm') || !loader.includes('lld.data')) {
	throw new Error('lld.js no longer references the matching wasm and data files');
}

console.log(`Verified Emscripten LLD artifacts in ${artifactDir}`);
