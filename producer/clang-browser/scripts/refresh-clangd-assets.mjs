#!/usr/bin/env node

// Refresh only clangd in a separate local artifact directory.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { assertClangdStdinBridge } from './clangd-artifact-contract.mjs';
import { CLANGD_HEADER_ASSET, verifyClangdHeaderAsset } from './clangd-header-asset-contract.mjs';
import { loadMemfsReleaseFiles } from './memfs-provenance.mjs';
import { verifyClangArtifacts } from './verify-artifacts.mjs';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const scriptPath = fileURLToPath(import.meta.url);
const producerRoot = path.resolve(path.dirname(scriptPath), '..');
const MAX_HEADER_BYTES = 128 * 1024 * 1024;
const MAX_WASM_BYTES = 256 * 1024 * 1024;
const replacedFiles = new Set([
	'toolchain.json',
	'clangd/clangd.js',
	'clangd/clangd.wasm.gz',
	CLANGD_HEADER_ASSET
]);
const digest = (bytes) => ({
	bytes: bytes.length,
	sha256: createHash('sha256').update(bytes).digest('hex')
});

function contains(parent, child) {
	const relative = path.relative(parent, child);
	return (
		!relative ||
		(!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
	);
}

async function canonicalOutput(filename) {
	const absolute = path.resolve(filename);
	const existing = await fs.lstat(absolute).catch((error) => {
		if (error.code === 'ENOENT') return null;
		throw error;
	});
	if (existing) return await fs.realpath(absolute);
	return path.join(await canonicalOutput(path.dirname(absolute)), path.basename(absolute));
}

async function snapshotDirectory(directory) {
	const files = new Map();
	async function visit(relative) {
		const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
		for (const entry of entries.sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0
		)) {
			const name = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await visit(name);
			else if (entry.isFile()) files.set(name, await fs.readFile(path.join(directory, name)));
			else throw new Error(`Artifact input is not a regular file: ${name}`);
		}
	}
	await visit('');
	return files;
}

/**
 * Stage a clangd-only refresh, preserving every other source file and metadata field.
 * The output must be empty or absent and disjoint from both input directories.
 */
export async function refreshClangdAssets({ sourceArtifacts, clangdDir, outDir, buildReceipt }) {
	for (const [name, value] of Object.entries({ sourceArtifacts, clangdDir, outDir })) {
		if (typeof value !== 'string' || !value) throw new Error(`Missing required path: ${name}`);
	}
	const source = await fs.realpath(path.resolve(sourceArtifacts));
	const prepared = await fs.realpath(path.resolve(clangdDir));
	const out = await canonicalOutput(outDir);
	if ([source, prepared].some((input) => contains(input, out) || contains(out, input))) {
		throw new Error(
			'Output directory must be outside and disjoint from both input directories'
		);
	}
	const outputEntries = await fs.readdir(out).catch((error) => {
		if (error.code === 'ENOENT') return [];
		throw error;
	});
	if (outputEntries.length) throw new Error('Output directory must be empty or absent');
	await verifyClangArtifacts(source);
	const sourceFiles = await snapshotDirectory(source);
	const sourceMetadata = JSON.parse(sourceFiles.get('toolchain.json').toString('utf8'));
	for (const [name, expected] of Object.entries(sourceMetadata.assets)) {
		if (digest(sourceFiles.get(name)).sha256 !== expected)
			throw new Error(`Source changed during verification: ${name}`);
	}
	if (sourceMetadata.memfs) {
		await loadMemfsReleaseFiles(source, sourceMetadata.memfs, sourceFiles.get('memfs.zip'));
		for (const [name, expected] of Object.entries(sourceMetadata.memfs.files)) {
			const actual = digest(sourceFiles.get(name));
			if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
				throw new Error(`Source changed during verification: ${name}`);
		}
	}

	async function readPreparedFile(name) {
		const filename = path.join(prepared, name);
		if (!(await fs.lstat(filename)).isFile())
			throw new Error(`Prepared input is not a regular file: ${name}`);
		return await fs.readFile(filename);
	}
	const js = await readPreparedFile('clangd.js');
	const rawPath = path.join(prepared, 'clangd.wasm');
	const gzPath = path.join(prepared, 'clangd.wasm.gz');
	const [hasRaw, hasGz] = await Promise.all(
		[rawPath, gzPath].map((filename) =>
			fs
				.stat(filename)
				.then(() => true)
				.catch((error) => {
					if (error.code === 'ENOENT') return false;
					throw error;
				})
		)
	);
	if (!hasRaw && !hasGz)
		throw new Error('Prepared clangd directory needs clangd.wasm or clangd.wasm.gz');
	const wasmInputPath = hasGz ? gzPath : rawPath;
	const wasmInput = await readPreparedFile(path.basename(wasmInputPath));
	const wasm = hasGz
		? await gunzipAsync(wasmInput, { maxOutputLength: MAX_WASM_BYTES })
		: wasmInput;
	if (wasm.length > MAX_WASM_BYTES)
		throw new Error('Prepared clangd module exceeds the byte limit');
	if (hasRaw && hasGz && !wasm.equals(await readPreparedFile('clangd.wasm')))
		throw new Error('Prepared raw and gzip clangd modules disagree');
	const wasmGz = hasGz ? wasmInput : await gzipAsync(wasm, { level: 9 });
	await assertClangdStdinBridge(js, wasm);
	const headersGz = await readPreparedFile(path.basename(CLANGD_HEADER_ASSET));
	if (headersGz.length > MAX_HEADER_BYTES)
		throw new Error('Prepared clangd headers exceed the byte limit');
	const headersRaw = await gunzipAsync(headersGz, { maxOutputLength: MAX_HEADER_BYTES });
	const tree = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headersRaw));
	const manifestBytes = await fs.readFile(path.join(producerRoot, 'manifest.json'));
	const manifest = JSON.parse(manifestBytes.toString('utf8'));
	if (
		tree.version !== `${sourceMetadata.version}:${sourceMetadata.llvmCommit}` ||
		tree.resourceDir !== sourceMetadata.resourceDir ||
		tree.targetTriple !== manifest.target
	)
		throw new Error(
			'Prepared headers do not match source toolchain version, resource directory or target'
		);
	const headerMetadata = {
		asset: CLANGD_HEADER_ASSET,
		format: 'clangd-headers-v1',
		version: digest(headersRaw).sha256,
		targetTriple: tree.targetTriple,
		resourceDir: tree.resourceDir,
		...digest(headersGz),
		uncompressedBytes: headersRaw.length,
		uncompressedSha256: digest(headersRaw).sha256
	};
	verifyClangdHeaderAsset(headersGz, headerMetadata);
	let commandReceipt;
	if (buildReceipt) {
		const filename = path.resolve(buildReceipt);
		const bytes = await fs.readFile(filename);
		const receipt = JSON.parse(bytes.toString('utf8'));
		if (
			typeof receipt.cwd !== 'string' ||
			!Array.isArray(receipt.argv) ||
			!receipt.argv.length ||
			receipt.argv.some((value) => typeof value !== 'string')
		) {
			throw new Error('Build receipt must contain the actual cwd and argv');
		}
		commandReceipt = { path: filename, ...digest(bytes), receipt };
	}
	const outputs = new Map([
		['clangd/clangd.js', js],
		['clangd/clangd.wasm.gz', wasmGz],
		[CLANGD_HEADER_ASSET, headersGz]
	]);
	const metadata = structuredClone(sourceMetadata);
	metadata.producer = { ...metadata.producer, manifestSha256: digest(manifestBytes).sha256 };
	metadata.clangd = {
		...metadata.clangd,
		headers: headerMetadata,
		headerSeparation: {
			format: 'wasm-llvm-clangd-header-separation-v1',
			scope: 'Clangd headers and initialization only; compiler, sysroot and MemFS preserved byte-for-byte',
			producerManifest: {
				path: 'producer/clang-browser/manifest.json',
				...digest(manifestBytes)
			},
			buildToolchain: {
				path: 'producer/clang-browser/scripts/build-toolchain.mjs',
				...digest(await fs.readFile(path.join(producerRoot, 'scripts/build-toolchain.mjs')))
			},
			refreshRecipe: {
				path: 'producer/clang-browser/scripts/refresh-clangd-assets.mjs',
				...digest(await fs.readFile(scriptPath))
			},
			sourceToolchain: {
				path: path.join(source, 'toolchain.json'),
				...digest(sourceFiles.get('toolchain.json'))
			},
			inputs: {
				js: { path: path.join(prepared, 'clangd.js'), ...digest(js) },
				wasm: {
					path: wasmInputPath,
					...digest(wasmInput),
					uncompressedBytes: wasm.length,
					uncompressedSha256: digest(wasm).sha256
				},
				headers: {
					path: path.join(prepared, path.basename(CLANGD_HEADER_ASSET)),
					...headerMetadata
				}
			},
			outputs: {
				'clangd/clangd.js': digest(js),
				'clangd/clangd.wasm.gz': {
					...digest(wasmGz),
					uncompressedBytes: wasm.length,
					uncompressedSha256: digest(wasm).sha256
				},
				[CLANGD_HEADER_ASSET]: {
					...digest(headersGz),
					uncompressedBytes: headersRaw.length,
					uncompressedSha256: headerMetadata.version
				}
			},
			preservedFiles: Object.fromEntries(
				[...sourceFiles]
					.filter(([name]) => !replacedFiles.has(name))
					.map(([name, bytes]) => [name, digest(bytes)])
			),
			...(commandReceipt ? { buildCommand: commandReceipt } : {}),
			...(sourceMetadata.clangd?.headerSeparation
				? { previous: sourceMetadata.clangd.headerSeparation }
				: {})
		}
	};
	for (const [name, bytes] of outputs) metadata.assets[name] = digest(bytes).sha256;
	outputs.set('toolchain.json', Buffer.from(JSON.stringify(metadata, null, 2) + '\n'));
	await fs.mkdir(out, { recursive: true });
	for (const [name, bytes] of new Map([...sourceFiles, ...outputs])) {
		const filename = path.join(out, name);
		await fs.mkdir(path.dirname(filename), { recursive: true });
		await fs.writeFile(filename, bytes);
	}
	return {
		directory: out,
		headers: headerMetadata,
		preservedFiles: Object.keys(metadata.clangd.headerSeparation.preservedFiles).length,
		outputs: metadata.clangd.headerSeparation.outputs
	};
}

async function main() {
	const args = new Map();
	const allowed = new Set(['--source-artifacts', '--clangd-dir', '--out-dir', '--build-receipt']);
	for (let index = 2; index < process.argv.length; index += 2) {
		const name = process.argv[index];
		if (
			!allowed.has(name) ||
			!process.argv[index + 1] ||
			process.argv[index + 1].startsWith('--')
		)
			throw new Error(`Unexpected or incomplete option: ${name}`);
		if (args.has(name)) throw new Error(`Duplicate option: ${name}`);
		args.set(name, process.argv[index + 1]);
	}
	const result = await refreshClangdAssets({
		sourceArtifacts: args.get('--source-artifacts'),
		clangdDir: args.get('--clangd-dir'),
		outDir: args.get('--out-dir'),
		buildReceipt: args.get('--build-receipt')
	});
	console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
