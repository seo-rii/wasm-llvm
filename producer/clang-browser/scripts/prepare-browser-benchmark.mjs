#!/usr/bin/env node

// Prepare local, byte-identifiable fixtures without changing packaged artifacts.
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { EXPECTED_OUTPUT, SOURCES } from './benchmark-compiler.mjs';
import { CLANGD_HEADER_ASSET, verifyClangdHeaderAsset } from './clangd-header-asset-contract.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PROVENANCE_FILES = ['compiler-build.json', 'toolchain.json', 'benchmark-provenance.json'];
const MAX_RAW_BYTES = 128 * 1024 * 1024;

function receipt(compressed, raw = gunzipSync(compressed, { maxOutputLength: MAX_RAW_BYTES })) {
	return {
		bytes: compressed.length,
		sha256: sha256(compressed),
		uncompressedBytes: raw.length,
		uncompressedSha256: sha256(raw)
	};
}

function variantName(name) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(name))
		throw new Error(`Invalid fixture name: ${name}`);
	return name;
}

async function provenance(directory) {
	const entries = [];
	for (const name of PROVENANCE_FILES) {
		const filename = path.join(directory, name);
		if (!(await stat(filename).catch(() => null))) continue;
		const bytes = await readFile(filename);
		entries.push({
			file: filename,
			sha256: sha256(bytes),
			receipt: JSON.parse(bytes.toString('utf8'))
		});
	}
	return entries;
}

/**
 * Paths in config are relative to configDirectory. Compiler entries use rawDirectory
 * or compressedDirectory; shared memfs/sysroot bytes come from compilerAssets.
 * Clangd entries use directory, implementation (shipped/current), optional rawWasm,
 * and headers (false or the canonical filename).
 */
export async function prepareBrowserBenchmark(
	config,
	outDirectory,
	configDirectory = process.cwd()
) {
	const resolve = (value) => {
		if (typeof value !== 'string' || !value)
			throw new Error('Expected a non-empty fixture input path');
		return path.resolve(configDirectory, value);
	};
	const out = path.resolve(outDirectory);
	const runtimeManifest = JSON.parse(await readFile(resolve(config.runtimeManifest), 'utf8'));
	const sharedDirectory = resolve(config.compilerAssets);
	const fixtures = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		gzipLevel: 9,
		configSha256: sha256(Buffer.from(JSON.stringify(config))),
		sourceSha256: Object.fromEntries(
			Object.entries(SOURCES).map(([name, source]) => [name, sha256(Buffer.from(source))])
		),
		files: {},
		compiler: {},
		clangd: {}
	};
	async function install(key, bytes) {
		const filename = path.join(out, key);
		await mkdir(path.dirname(filename), { recursive: true });
		await writeFile(filename, bytes);
		fixtures.files[key] = filename;
	}
	const workloads = Object.entries(SOURCES).map(([name, source]) => ({
		name,
		source,
		args: ['-O2'],
		language: name.endsWith('.c') ? 'C' : 'CPP',
		standard: name.endsWith('.c') ? 'c17' : name === 'templates.cpp' ? 'c++20' : 'c++17',
		expected: EXPECTED_OUTPUT[name]
	}));
	for (const [key, entry] of Object.entries(config.compiler || {})) {
		const name = variantName(key);
		if (!!entry.rawDirectory === !!entry.compressedDirectory)
			throw new Error(`Specify exactly one compiler directory for ${name}`);
		const directory = resolve(entry.rawDirectory || entry.compressedDirectory);
		const receipts = {};
		for (const module of ['clang', 'lld', 'memfs', 'sysroot']) {
			const asset = `bin/${module === 'sysroot' ? 'sysroot.tar' : module + '.wasm'}.gz`;
			let bytes;
			if (module === 'clang' || module === 'lld') {
				bytes = entry.rawDirectory
					? gzipSync(await readFile(path.join(directory, module)), { level: 9 })
					: await readFile(path.join(directory, path.basename(asset)));
			} else bytes = await readFile(path.join(sharedDirectory, path.basename(asset)));
			receipts[asset] = receipt(bytes);
			await install(`${name}/clang/${asset}`, bytes);
		}
		const supplemental = runtimeManifest.compiler?.sysroot?.printscanLongDouble?.asset;
		if (supplemental !== undefined) {
			if (
				typeof supplemental !== 'string' ||
				!supplemental ||
				/[\\?#\x00-\x1f]/u.test(supplemental) ||
				supplemental.split('/').some((part) => !part || part === '.' || part === '..')
			)
				throw new Error('Invalid supplemental sysroot asset path');
			const bytes = await readFile(path.join(sharedDirectory, '..', supplemental));
			receipts[supplemental] = receipt(bytes);
			await install(`${name}/clang/${supplemental}`, bytes);
		}
		fixtures.compiler[name] = {
			basePath: `/${name}/clang/`,
			manifest: structuredClone(runtimeManifest),
			receipts,
			workloads,
			provenance: await provenance(directory)
		};
	}
	for (const [key, entry] of Object.entries(config.clangd || {})) {
		const name = variantName(key);
		if (!['shipped', 'current'].includes(entry.implementation))
			throw new Error(`Invalid clangd implementation: ${name}`);
		if (entry.rawWasm && path.basename(entry.rawWasm) !== entry.rawWasm)
			throw new Error('rawWasm must be a filename');
		if (entry.headers && entry.headers !== path.basename(CLANGD_HEADER_ASSET))
			throw new Error('Unexpected clangd header asset filename');
		const directory = resolve(entry.directory);
		const integrity = {};
		const js = await readFile(path.join(directory, 'clangd.js'));
		integrity['clangd.js'] = receipt(js, js);
		await install(`${name}/clangd/clangd.js`, js);
		const wasm = entry.rawWasm
			? gzipSync(await readFile(path.join(directory, entry.rawWasm)), {
					level: 9
				})
			: await readFile(path.join(directory, 'clangd.wasm.gz'));
		integrity['clangd.wasm.gz'] = receipt(wasm);
		await install(`${name}/clangd/clangd.wasm.gz`, wasm);
		if (entry.headers) {
			const bytes = await readFile(path.join(directory, entry.headers));
			const headerReceipt = receipt(bytes);
			const rawTree = JSON.parse(
				gunzipSync(bytes, { maxOutputLength: MAX_RAW_BYTES }).toString('utf8')
			);
			verifyClangdHeaderAsset(bytes, {
				asset: CLANGD_HEADER_ASSET,
				format: 'clangd-headers-v1',
				version: headerReceipt.uncompressedSha256,
				targetTriple: rawTree.targetTriple,
				resourceDir: rawTree.resourceDir,
				...headerReceipt
			});
			integrity[entry.headers] = headerReceipt;
			await install(`${name}/clangd/${entry.headers}`, bytes);
		}
		fixtures.clangd[name] = {
			basePath: `/${name}/clangd/`,
			integrity,
			implementation: entry.implementation,
			headers: entry.headers || false,
			provenance: await provenance(directory)
		};
	}
	await mkdir(out, { recursive: true });
	await writeFile(path.join(out, 'fixtures.json'), JSON.stringify(fixtures, null, 2) + '\n');
	return fixtures;
}

async function main() {
	const args = new Map();
	for (let index = 2; index < process.argv.length; index += 2)
		args.set(process.argv[index], process.argv[index + 1]);
	if (!args.get('--config') || !args.get('--out-dir'))
		throw new Error('--config and --out-dir are required');
	const filename = path.resolve(args.get('--config'));
	const config = JSON.parse(await readFile(filename, 'utf8'));
	const fixtures = await prepareBrowserBenchmark(
		config,
		args.get('--out-dir'),
		path.dirname(filename)
	);
	console.log(
		`Prepared ${Object.keys(fixtures.compiler).length} compiler and ${Object.keys(fixtures.clangd).length} clangd variants: ${path.resolve(args.get('--out-dir'), 'fixtures.json')}`
	);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
