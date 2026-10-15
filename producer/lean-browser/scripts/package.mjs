// Package and verify the lean-browser release.
// Usage:
//   node package.mjs [--work <workDir>] [--out <artifactDir>]   package, smoke, and write the receipt
//   node package.mjs --verify [artifactDir]                      verify a packaged release
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync, constants } from 'node:zlib';

import { publishDirectory } from './publish-directory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRODUCER = path.dirname(HERE);
const REPO = path.resolve(PRODUCER, '../..');
const DEFAULT_OUT = path.join(REPO, 'artifacts/lean-browser');
const DEFAULT_WORK = path.join(REPO, 'out/lean-browser-work');
/** Raw library bytes per chunk; each gzip chunk must stay below static-host file limits. */
export const CHUNK_BYTES = 48 * 1024 * 1024;
export const MAX_FILE_BYTES = 24 * 1000 * 1000;
export const MAX_WASM_BYTES = 512 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUIRED_ASSETS = ['LICENSE', 'LICENSE.libuv', 'lean.mjs', 'lean.wasm.gz', 'lean-init.index.json'];
const validSize = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;
const validDigest = (asset, max) => validSize(asset?.bytes, max) && typeof asset.sha256 === 'string' && SHA256.test(asset.sha256);
const LIBRARY_EXTENSIONS = ['.olean', '.olean.server', '.olean.private', '.ir', '.ir.sig'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const gzip = (bytes) => gzipSync(bytes, { level: constants.Z_BEST_COMPRESSION });
const receiptOf = (bytes) => ({ bytes: bytes.length, sha256: sha256(bytes) });

async function walk(root, relative = '') {
	const out = [];
	for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
		const child = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...(await walk(root, child)));
		else if (entry.isFile()) out.push(child);
	}
	return out;
}

export async function producerInputs() {
	const manifestBytes = await readFile(path.join(PRODUCER, 'manifest.json'));
	const manifest = JSON.parse(manifestBytes);
	const patches = [];
	for (const patch of manifest.patches) {
		const bytes = await readFile(path.join(PRODUCER, patch.path));
		if (sha256(bytes) !== patch.sha256) throw new Error(`${patch.path} does not match the manifest`);
		patches.push({ path: patch.path, sha256: patch.sha256 });
	}
	const recipe = {};
	for (const name of ['build.sh', 'build-oleans.mjs', 'run-lean.mjs', 'gen-symtab.py', 'package.mjs', 'publish-directory.mjs', 'smoke.mjs'])
		recipe[`scripts/${name}`] = sha256(await readFile(path.join(HERE, name)));
	return { manifest, manifestSha256: sha256(manifestBytes), patches, recipe };
}

/** Build the release file map (name -> bytes) from a finished work directory. */
export async function assemble(workDir) {
	const files = new Map();
	files.set('lean.mjs', await readFile(path.join(workDir, 'dist/lean.mjs')));
	const wasm = await readFile(path.join(workDir, 'dist/lean.wasm'));
	if (!WebAssembly.validate(wasm)) throw new Error('lean.wasm is not valid WebAssembly');
	files.set('lean.wasm.gz', gzip(wasm));
	files.set('LICENSE', await readFile(path.join(workDir, 'lean4/LICENSE')));
	files.set('LICENSE.libuv', await readFile(path.join(workDir, 'build-wasm/libuv/src/libuv/LICENSE')));
	const libraryRoot = path.join(workDir, 'olean32');
	const names = (await walk(libraryRoot))
		.filter((name) => LIBRARY_EXTENSIONS.some((ext) => name.endsWith(ext)))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const modules = names.filter((name) => name.endsWith('.olean'));
	for (const name of modules) {
		for (const ext of LIBRARY_EXTENSIONS)
			if (!names.includes(name.replace(/\.olean$/, ext)))
				throw new Error(`library module ${name} is missing its ${ext} part`);
	}
	let offset = 0;
	const entries = [];
	const parts = [];
	for (const name of names) {
		const bytes = await readFile(path.join(libraryRoot, name));
		entries.push({ path: name, offset, bytes: bytes.length });
		parts.push(bytes);
		offset += bytes.length;
	}
	const pack = Buffer.concat(parts, offset);
	const chunks = [];
	for (let start = 0, i = 0; start < pack.length; start += CHUNK_BYTES, i++) {
		const raw = pack.subarray(start, Math.min(pack.length, start + CHUNK_BYTES));
		const name = `lean-init-${String(i).padStart(2, '0')}.pack.gz`;
		const compressed = gzip(raw);
		if (compressed.length > MAX_FILE_BYTES) throw new Error(`${name} exceeds ${MAX_FILE_BYTES} bytes`);
		files.set(name, compressed);
		chunks.push({
			path: name,
			offset: start,
			uncompressedBytes: raw.length,
			uncompressedSha256: sha256(raw),
			...receiptOf(compressed)
		});
	}
	const index = {
		schemaVersion: 1,
		root: '/lean/lib/lean',
		modules: modules.length,
		totalBytes: pack.length,
		sha256: sha256(pack),
		chunks,
		files: entries
	};
	files.set('lean-init.index.json', Buffer.from(`${JSON.stringify(index, null, '\t')}\n`));
	return { files, wasm };
}

export function assetReceipts(files, wasm) {
	const assets = {};
	for (const [name, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
		assets[name] = receiptOf(bytes);
		if (name === 'lean.wasm.gz') assets[name].uncompressed = receiptOf(wasm);
	}
	return assets;
}

export async function packageRelease({ workDir = DEFAULT_WORK, outDir = DEFAULT_OUT } = {}) {
	const { acceptance } = await import('./smoke.mjs');
	return publishDirectory(outDir, async (staging) => {
		const inputs = await producerInputs();
		const { files, wasm } = await assemble(workDir);
		for (const [name, bytes] of files) await writeFile(path.join(staging, name), bytes);
		const node = await acceptance(staging);
		const receipt = {
			schemaVersion: 1,
			producerId: inputs.manifest.producerId,
			manifestSha256: inputs.manifestSha256,
			sources: inputs.manifest.sources,
			bootstrap: inputs.manifest.bootstrap,
			patches: inputs.patches,
			recipe: inputs.recipe,
			runtime: inputs.manifest.runtime,
			library: JSON.parse(files.get('lean-init.index.json')).modules,
			assets: assetReceipts(files, wasm),
			acceptance: { node }
		};
		await writeFile(
			path.join(staging, 'producer-receipt.json'),
			`${JSON.stringify(receipt, null, '\t')}\n`
		);
		const result = await verify(staging);
		return { ...result, directory: path.resolve(outDir) };
	});
}

/** Verify a packaged release against its receipt and the current producer inputs. */
export async function verify(directory = DEFAULT_OUT) {
	const receipt = JSON.parse(await readFile(path.join(directory, 'producer-receipt.json'), 'utf8'));
	const inputs = await producerInputs();
	if (receipt.manifestSha256 !== inputs.manifestSha256)
		throw new Error('receipt was produced from a different producer manifest');
	if (JSON.stringify(receipt.patches) !== JSON.stringify(inputs.patches))
		throw new Error('receipt patches differ from the producer patches');
	if (JSON.stringify(receipt.recipe) !== JSON.stringify(inputs.recipe))
		throw new Error('receipt recipe hashes differ from the producer scripts');
	if (receipt.requalification) {
		const { kind, compilerRebuilt, originalReceipt, originalReceiptSha256 } = receipt.requalification;
		if (kind !== 'same-byte-repackage' || compilerRebuilt !== false || !originalReceipt ||
			sha256(`${JSON.stringify(originalReceipt, null, '\t')}\n`) !== originalReceiptSha256)
			throw new Error('invalid same-byte requalification provenance');
		for (const field of ['assets', 'sources', 'bootstrap', 'patches', 'manifestSha256', 'runtime'])
			if (JSON.stringify(originalReceipt[field]) !== JSON.stringify(receipt[field]))
				throw new Error(`requalification changed original ${field}`);
		for (const [name, hash] of Object.entries(inputs.recipe))
			if (!['scripts/package.mjs', 'scripts/publish-directory.mjs'].includes(name) && originalReceipt.recipe?.[name] !== hash)
				throw new Error(`requalification changed build recipe ${name}`);
	}
	if (receipt.schemaVersion !== 1 || !receipt.assets || Array.isArray(receipt.assets))
		throw new Error('unsupported receipt schema');
	for (const name of REQUIRED_ASSETS)
		if (!Object.hasOwn(receipt.assets, name)) throw new Error(`missing required asset: ${name}`);
	const expected = [...Object.keys(receipt.assets), 'producer-receipt.json'].sort();
	const actual = (await readdir(directory)).sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected))
		throw new Error(`unexpected release entries: ${actual.join(', ')}`);
	for (const [name, asset] of Object.entries(receipt.assets)) {
		if (!REQUIRED_ASSETS.includes(name) && !/^lean-init-\d{2,}\.pack\.gz$/.test(name))
			throw new Error(`invalid release asset path: ${name}`);
		if (!validDigest(asset, MAX_FILE_BYTES)) throw new Error(`invalid asset receipt: ${name}`);
		const info = await lstat(path.join(directory, name));
		if (!info.isFile()) throw new Error(`asset is not a regular file: ${name}`);
		if (info.size !== asset.bytes) throw new Error(`${name} does not match the receipt`);
		const bytes = await readFile(path.join(directory, name));
		if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256)
			throw new Error(`${name} does not match the receipt`);
		if (name === 'lean.wasm.gz') {
			if (!validDigest(asset.uncompressed, MAX_WASM_BYTES)) throw new Error('invalid Wasm uncompressed receipt');
			const raw = gunzipSync(bytes, { maxOutputLength: asset.uncompressed.bytes });
			if (raw.length !== asset.uncompressed.bytes || sha256(raw) !== asset.uncompressed.sha256)
				throw new Error(`${name} decompresses to unexpected bytes`);
			await WebAssembly.compile(raw);
		} else if (asset.uncompressed) throw new Error(`unexpected uncompressed receipt: ${name}`);
	}
	const index = JSON.parse(await readFile(path.join(directory, 'lean-init.index.json'), 'utf8'));
	if (index.schemaVersion !== 1 || index.root !== '/lean/lib/lean' ||
		!validSize(index.totalBytes, Number.MAX_SAFE_INTEGER) || !validSize(index.modules, Number.MAX_SAFE_INTEGER) ||
		!SHA256.test(index.sha256) || !Array.isArray(index.chunks) || !index.chunks.length || !Array.isArray(index.files))
		throw new Error('invalid library index schema');
	let offset = 0;
	const chunkPaths = new Set();
	// Validate every range and path before decompressing any library chunk.
	for (const chunk of index.chunks) {
		if (typeof chunk.path !== 'string' || !/^lean-init-\d{2,}\.pack\.gz$/.test(chunk.path) ||
			chunkPaths.has(chunk.path) || !Object.hasOwn(receipt.assets, chunk.path) ||
			!validDigest(chunk, MAX_FILE_BYTES) || !validSize(chunk.uncompressedBytes, CHUNK_BYTES) ||
			!SHA256.test(chunk.uncompressedSha256) || !Number.isSafeInteger(chunk.offset) || chunk.offset !== offset ||
			!Number.isSafeInteger(offset + chunk.uncompressedBytes) || offset + chunk.uncompressedBytes > index.totalBytes ||
			chunk.bytes !== receipt.assets[chunk.path].bytes || chunk.sha256 !== receipt.assets[chunk.path].sha256)
			throw new Error(`invalid library chunk: ${chunk.path}`);
		chunkPaths.add(chunk.path);
		offset += chunk.uncompressedBytes;
	}
	if (offset !== index.totalBytes || Object.keys(receipt.assets).some((name) => !REQUIRED_ASSETS.includes(name) && !chunkPaths.has(name)))
		throw new Error('library chunks do not cover the declared asset set and pack');
	let next = 0;
	const paths = new Set();
	for (const file of index.files) {
		if (typeof file.path !== 'string' || !/^Init(\/[A-Za-z0-9_]+)*\.(olean(\.server|\.private)?|ir(\.sig)?)$/.test(file.path) ||
			paths.has(file.path) || !Number.isSafeInteger(file.offset) || file.offset !== next ||
			!validSize(file.bytes, index.totalBytes) || !Number.isSafeInteger(next + file.bytes) || next + file.bytes > index.totalBytes)
			throw new Error(`invalid library entry ${file.path}`);
		paths.add(file.path);
		next += file.bytes;
	}
	if (next !== index.totalBytes) throw new Error('library entries do not cover the pack');
	const modules = [...paths].filter((name) => name.endsWith('.olean'));
	if (modules.length !== index.modules || !paths.has('Init.olean')) throw new Error('library module count or root is invalid');
	for (const name of modules)
		for (const ext of LIBRARY_EXTENSIONS)
			if (!paths.has(name.replace(/\.olean$/, ext))) throw new Error(`library module ${name} is missing its ${ext} part`);
	const digest = createHash('sha256');
	for (const chunk of index.chunks) {
		const raw = gunzipSync(await readFile(path.join(directory, chunk.path)), { maxOutputLength: chunk.uncompressedBytes });
		if (raw.length !== chunk.uncompressedBytes || sha256(raw) !== chunk.uncompressedSha256)
			throw new Error(`${chunk.path} does not match the library index`);
		digest.update(raw);
	}
	if (digest.digest('hex') !== index.sha256) throw new Error('library pack digest mismatch');
	if (receipt.acceptance?.node?.program?.stdout !== 'Hello, 안녕!\nsum = 40\n')
		throw new Error('receipt lacks a passing stdin/stdout acceptance run');
	const sizes = Object.fromEntries(Object.entries(receipt.assets).map(([k, v]) => [k, v.bytes]));
	return { directory, modules: index.modules, libraryBytes: index.totalBytes, sizes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args[0] === '--verify') {
		console.log(JSON.stringify(await verify(path.resolve(args[1] || DEFAULT_OUT)), null, 2));
	} else {
		const option = (flag, fallback) => {
			const i = args.indexOf(flag);
			return i >= 0 ? path.resolve(args[i + 1]) : fallback;
		};
		const result = await packageRelease({
			workDir: option('--work', DEFAULT_WORK),
			outDir: option('--out', DEFAULT_OUT)
		});
		console.log(JSON.stringify(result, null, 2));
	}
	process.exit(0);
}
