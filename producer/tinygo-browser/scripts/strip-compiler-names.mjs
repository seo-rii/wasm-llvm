#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const THIS_FILE = fileURLToPath(import.meta.url);
export const DERIVATION_FORMAT = 'wasm-llvm-tinygo-name-stripped-v1';
export const ROOT_MANIFEST_PATH = 'runtime/wasip1-asyncify-precise-o1/manifest.json';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const evidence = (bytes) => ({ bytes: bytes.length, sha256: digest(bytes) });

// Keep every byte outside the optional debug-name custom sections, including
// producers, target_features, DWARF, exports and executable/data sections.
export function stripCompilerNames(input) {
	const bytes = Buffer.from(input);
	assert(WebAssembly.validate(bytes), 'TinyGo compiler must be valid WebAssembly');
	let offset = 8;
	const pieces = [bytes.subarray(0, offset)];
	let removedBytes = 0;
	let removedSections = 0;
	function u32(limit) {
		let value = 0;
		for (let shift = 0; shift <= 28; shift += 7) {
			assert(offset < limit, 'truncated Wasm section length');
			const byte = bytes[offset++];
			assert(shift < 28 || byte < 16, 'overflowing Wasm section length');
			value += (byte & 127) * 2 ** shift;
			if (!(byte & 128)) return value;
		}
		throw new Error('invalid Wasm section length');
	}
	while (offset < bytes.length) {
		const start = offset;
		const id = bytes[offset++];
		const size = u32(bytes.length);
		const end = offset + size;
		assert(end <= bytes.length, 'truncated Wasm section');
		let isName = false;
		if (id === 0) {
			const length = u32(end);
			assert(offset + length <= end, 'truncated Wasm custom-section name');
			isName = bytes.subarray(offset, offset + length).equals(Buffer.from('name'));
		}
		if (isName) {
			removedBytes += end - start;
			removedSections += 1;
		} else pieces.push(bytes.subarray(start, end));
		offset = end;
	}
	const output = Buffer.concat(pieces);
	assert(WebAssembly.validate(output), 'name-stripped compiler must remain valid WebAssembly');
	return { output, removedBytes, removedSections };
}

// A digest is always 64 ASCII bytes. Update only that field inside the existing
// tar member, keeping all tar headers, file data and ordering byte-for-byte.
export function rebindRootCompiler(rootArchive, before, after) {
	assert(/^[a-f0-9]{64}$/.test(before) && /^[a-f0-9]{64}$/.test(after), 'invalid compiler digest');
	const tar = gunzipSync(rootArchive);
	let matches = 0;
	for (let offset = 0; offset + 512 <= tar.length;) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
		const sizeText = header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim();
		assert(/^[0-7]+$/.test(sizeText), 'unsupported tar member size');
		const size = Number.parseInt(sizeText, 8);
		const start = offset + 512;
		assert(start + size <= tar.length, 'truncated root tar');
		if (name === ROOT_MANIFEST_PATH) {
			assert(header[156] === 48 || header[156] === 0, 'runtime manifest must be a regular file');
			const source = tar.subarray(start, start + size).toString();
			assert.equal(JSON.parse(source).compilerSha256, before, 'root manifest does not bind input compiler');
			const pattern = /("compilerSha256"\s*:\s*")[a-f0-9]{64}(")/g;
			assert.equal([...source.matchAll(pattern)].length, 1, 'runtime compiler binding must occur once');
			const updated = source.replace(pattern, (_match, prefix, suffix) => `${prefix}${after}${suffix}`);
			assert.equal(Buffer.byteLength(updated), size, 'runtime binding changed tar member size');
			tar.write(updated, start, size);
			matches += 1;
		}
		offset = start + Math.ceil(size / 512) * 512;
	}
	assert.equal(matches, 1, 'root archive must contain exactly one runtime manifest');
	return gzipSync(tar, { level: 9 });
}

export async function deriveNameStrippedCompiler({ inputDir, outputDir }) {
	assert.notEqual(path.resolve(inputDir), path.resolve(outputDir), 'derivation output must be separate');
	const [compiler, rootArchive, sourceReceipt] = await Promise.all([
		readFile(path.join(inputDir, 'tinygo-compiler.wasm')),
		readFile(path.join(inputDir, 'tinygoroot.tar.gz')),
		readFile(path.join(inputDir, 'producer-receipt.json'))
	]);
	const original = JSON.parse(sourceReceipt);
	assert.equal(original.schemaVersion, 6, 'derivation requires an original v6 compiler receipt');
	assert.equal(original.format, 'wasm-llvm-tinygo-browser-compiler-v6', 'derivation requires an original v6 compiler receipt');
	assert.equal(original.producerId, 'wasm-llvm/tinygo-browser');
	assert.equal(original.verification?.status, 'passed', 'input verification must have passed');
	assert.equal(original.verification?.identityMode, 'upstream-package-graph');
	assert.equal(original.verification?.acceptance?.status, 'passed', 'input acceptance must have passed');
	for (const [assetPath, bytes] of [['tinygo-compiler.wasm', compiler], ['tinygoroot.tar.gz', rootArchive]]) {
		const asset = original.assets.find((entry) => entry.path === assetPath);
		assert.deepEqual(asset, { path: assetPath, ...evidence(bytes) }, `original receipt does not bind ${assetPath}`);
	}
	const stripped = stripCompilerNames(compiler);
	assert(stripped.removedSections > 0, 'compiler has no name section to remove');
	const outputCompiler = evidence(stripped.output);
	const outputRoot = rebindRootCompiler(rootArchive, digest(compiler), outputCompiler.sha256);
	const receipt = {
		schemaVersion: 1,
		format: DERIVATION_FORMAT,
		producerId: 'wasm-llvm/tinygo-browser',
		// This is the exact original receipt, not a new claim that its acceptance
		// fixture ran on the derived bytes. Consumer browser acceptance is separate.
		inputReceipt: { ...evidence(sourceReceipt), source: sourceReceipt.toString('utf8') },
		transformation: {
			id: 'strip-name-and-rebind-runtime-v1',
			tool: { path: 'producer/tinygo-browser/scripts/strip-compiler-names.mjs', ...evidence(await readFile(THIS_FILE)) },
			compiler: { input: evidence(compiler), output: outputCompiler, removedSections: stripped.removedSections, removedBytes: stripped.removedBytes, preservedSectionsSha256: outputCompiler.sha256 },
			rootArchive: { input: evidence(rootArchive), output: evidence(outputRoot), manifestPath: ROOT_MANIFEST_PATH, field: 'compilerSha256', before: digest(compiler), after: outputCompiler.sha256 },
			verification: 'non-name-sections-byte-identical',
			acceptance: 'preserved-input-receipt-only'
		},
		assets: [
			{ path: 'tinygo-compiler.wasm', ...outputCompiler },
			{ path: 'tinygoroot.tar.gz', ...evidence(outputRoot) }
		]
	};
	await mkdir(outputDir, { recursive: false });
	await Promise.all([
		writeFile(path.join(outputDir, 'tinygo-compiler.wasm'), stripped.output, { flag: 'wx' }),
		writeFile(path.join(outputDir, 'tinygoroot.tar.gz'), outputRoot, { flag: 'wx' }),
		writeFile(path.join(outputDir, 'producer-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
	]);
	return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	if (process.argv.length !== 4) throw new Error('Usage: strip-compiler-names.mjs INPUT_DIR NEW_OUTPUT_DIR');
	deriveNameStrippedCompiler({ inputDir: process.argv[2], outputDir: process.argv[3] }).then(
		(receipt) => console.log(JSON.stringify({ assets: receipt.assets, removedBytes: receipt.transformation.compiler.removedBytes })),
		(error) => { console.error(error); process.exitCode = 1; }
	);
}
