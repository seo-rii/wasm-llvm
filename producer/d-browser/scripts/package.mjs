#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import {
	artifactPath, assertReceipt, describeArtifact, jsonBytes, publishArtifacts, readRegular,
	readVerified, sha256, verifyArtifactDirectory, writeArtifact
} from '../../../scripts/lib/verified-artifacts.mjs';

const run = promisify(execFile);
const compress = promisify(gzip);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORMAT = 'wasm-llvm-d-browser-artifacts-v1';
const INPUTS = ['bin/ldc2.wasm', 'bin/lld.js', 'bin/lld.wasm', 'bin/lld.data',
	'etc/ldc2.conf.tar.zst', 'lib/imports.tar.zst', 'lib/runtime-libs.tar.zst'];
const COMPILER_OUTPUTS = ['bin/ldc2.wasm.gz', 'bin/lld.js', 'bin/lld.wasm.gz',
	'bin/lld.data.gz', 'toolchain/toolchain.tar.gz'];
const OUTPUTS = [...COMPILER_OUTPUTS, 'runtime-manifest.v1.json', 'runtime-build.json'];

export async function loadContract() {
	const manifestBytes = await readRegular(ROOT, 'manifest.json', 1024 * 1024);
	const manifest = JSON.parse(manifestBytes);
	const lockBytes = await readRegular(ROOT, 'sources.lock.json', 1024 * 1024);
	if (sha256(lockBytes) !== manifest.sourceLockSha256) throw new Error('D source lock does not match its manifest');
	const lock = JSON.parse(lockBytes);
	const portLockBytes = await readRegular(ROOT, manifest.sourcePortLock, 1024 * 1024);
	if (sha256(portLockBytes) !== manifest.sourcePortLockSha256)
		throw new Error('D source port lock does not match its manifest');
	const portLock = JSON.parse(portLockBytes);
	if (portLock.commit !== manifest.sources.ldcWasm.commit || !Array.isArray(portLock.files))
		throw new Error('Invalid D source port contract');
	for (const file of portLock.files) await readVerified(ROOT, file.path, file);
	if (manifest.schemaVersion !== 1 || manifest.producerId !== 'wasm-llvm/d-browser' ||
		lock.schemaVersion !== 1 || lock.profileId !== manifest.sources.ldcWasm.version ||
		JSON.stringify(lock.assets.map((entry) => entry.path)) !== JSON.stringify(INPUTS) ||
		JSON.stringify(lock.outputs.map((entry) => entry.path)) !== JSON.stringify(OUTPUTS)) {
		throw new Error('Invalid D producer source contract');
	}
	return {
		manifest, lock,
		identity: { schemaVersion: 1, format: FORMAT, producerId: manifest.producerId,
			manifestSha256: sha256(manifestBytes), sourceLockSha256: sha256(lockBytes) }
	};
}

// Receipts describe the bytes delivered and the original compiler bytes independently.
function paired(entry) {
	return { bytes: entry.bytes, sha256: entry.sha256,
		uncompressedBytes: entry.uncompressedBytes ?? entry.bytes,
		uncompressedSha256: entry.uncompressedSha256 ?? entry.sha256 };
}

function metadata(contract, artifacts) {
	const asset = (name, argv0) => {
		const entry = artifacts.find((candidate) => candidate.path === name);
		return { asset: name, ...(argv0 ? { argv0 } : {}),
			...(name.endsWith('.gz') ? { compression: 'gzip' } : {}), integrity: paired(entry) };
	};
	const manifest = jsonBytes({
		manifestVersion: 1, name: 'wasm-d', version: contract.lock.profileId, defaultTarget: 'wasm32-wasi',
		compiler: {
			ldc2: asset('bin/ldc2.wasm.gz', 'ldc2'), toolchain: asset('toolchain/toolchain.tar.gz'),
			linker: { kind: 'emscripten-lld', argv0: 'wasm-ld', js: asset('bin/lld.js'),
				wasm: asset('bin/lld.wasm.gz'), data: asset('bin/lld.data.gz') }
		},
		targets: { 'wasm32-wasi': { artifactFormat: 'wasi-core-wasm', execution: { kind: 'wasi-preview1' } } }
	});
	const build = jsonBytes({
		generatedAt: '1970-01-01T00:00:00.000Z',
		source: `ldc-wasm:${contract.manifest.sources.ldcWasm.commit}/dist/wasm-idle`,
		manifestSha256: sha256(manifest), sourceAssets: [...INPUTS].sort(),
		assets: [...COMPILER_OUTPUTS].sort().map((name) => {
			const entry = artifacts.find((candidate) => candidate.path === name);
			return { asset: name, size: entry.bytes, sha256: entry.sha256,
				uncompressedSize: entry.uncompressedBytes ?? entry.bytes,
				uncompressedSha256: entry.uncompressedSha256 ?? entry.sha256 };
		})
	});
	return { 'runtime-manifest.v1.json': manifest, 'runtime-build.json': build };
}

export async function verifyDArtifacts(directory, contract) {
	contract ??= await loadContract();
	const receipt = await verifyArtifactDirectory(directory, contract.identity, contract.lock.outputs);
	for (const [name, expected] of Object.entries(metadata(contract, receipt.artifacts))) {
		assertReceipt(await readRegular(directory, name), describeArtifact(name, expected), name);
	}
	return receipt;
}

async function extractToolchain(archive, target) {
	const options = { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120_000, env: { ...process.env, LC_ALL: 'C' } };
	const { stdout: names } = await run('tar', ['--zstd', '-tf', archive], options);
	const { stdout: entries } = await run('tar', ['--zstd', '-tvf', archive], options);
	for (const name of names.trimEnd().split('\n')) {
		const normalized = name.replace(/^\.\//u, '').replace(/\/$/u, '');
		if (normalized) artifactPath(normalized);
	}
	if (!entries.trim() || entries.trimEnd().split('\n').some((line) => !/^[d-]/u.test(line))) {
		throw new Error('D toolchain archives must contain only regular files and directories');
	}
	await mkdir(target, { recursive: true });
	await run('tar', ['--zstd', '-xf', archive, '-C', target, '--no-same-owner'], options);
}

export async function packageD({ sourceDir, outputDir, contract } = {}) {
	contract ??= await loadContract();
	if (!sourceDir || !outputDir) throw new Error('D packaging requires explicit source and output directories');
	// Validate every input before creating an output or invoking an archive tool.
	const sourceManifest = JSON.parse(await readVerified(sourceDir, contract.lock.sourceManifest.path, contract.lock.sourceManifest));
	const sourceBuild = JSON.parse(await readVerified(sourceDir, contract.lock.sourceBuild.path, contract.lock.sourceBuild));
	if (sourceManifest.manifestVersion !== 1 || sourceManifest.name !== 'ldc-wasm' ||
		sourceManifest.version !== contract.lock.profileId || sourceManifest.defaultTarget !== 'wasm32-wasi' ||
		JSON.stringify(sourceBuild.assets?.map((entry) => ({ path: entry.asset, bytes: entry.size, sha256: entry.sha256 }))) !==
		JSON.stringify(contract.lock.assets)) throw new Error('D finalized source metadata does not match its contract');
	const inputs = new Map();
	for (const entry of contract.lock.assets) inputs.set(entry.path, await readVerified(sourceDir, entry.path, entry));
	return publishArtifacts(outputDir, [sourceDir], async (temporary) => {
		const work = await mkdtemp(path.join(os.tmpdir(), 'wasm-llvm-d-'));
		try {
			const artifacts = [];
			const emit = async (name, bytes) => {
				await writeArtifact(temporary, name, bytes);
				artifacts.push(describeArtifact(name, bytes, name.endsWith('.gz') ? 'gzip' : undefined));
			};
			for (const name of INPUTS.slice(0, 4)) {
				const raw = inputs.get(name);
				await emit(name.endsWith('.js') ? name : `${name}.gz`, name.endsWith('.js') ? raw : await compress(raw, { level: 9 }));
			}
			const toolchain = path.join(work, 'toolchain');
			await mkdir(path.join(toolchain, 'etc'), { recursive: true });
			await mkdir(path.join(toolchain, 'imports'), { recursive: true });
			for (const [name, destination] of [
				['etc/ldc2.conf.tar.zst', 'etc'], ['lib/imports.tar.zst', 'imports'], ['lib/runtime-libs.tar.zst', '']
			]) {
				// Archive commands only see the already verified snapshot, never mutable source files.
				await writeArtifact(work, name, inputs.get(name));
				await extractToolchain(path.join(work, name), path.join(toolchain, destination));
			}
			const archive = path.join(work, 'toolchain.tar');
			await run('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
				'-cf', archive, '-C', toolchain, '.'], { timeout: 120_000 });
			await emit('toolchain/toolchain.tar.gz', await compress(await readFile(archive), { level: 9 }));
			for (const [name, bytes] of Object.entries(metadata(contract, artifacts))) await emit(name, bytes);
			const receipt = { ...contract.identity, artifacts };
			await writeArtifact(temporary, 'producer-receipt.json', jsonBytes(receipt));
			await verifyDArtifacts(temporary, contract);
			return receipt;
		} finally {
			await rm(work, { recursive: true, force: true });
		}
	});
}

async function main() {
	const args = process.argv.slice(2).filter((arg) => arg !== '--');
	const options = { sourceDir: process.env.WASM_LLVM_D_SOURCE_DIR, outputDir: path.resolve(ROOT, '../../out/d-browser') };
	const seen = new Set();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--help') {
			console.log('package:d -- --source <finalized-ldc-wasm-dir> --out <new-output-dir>\nverify:d-artifacts -- --verify <output-dir>');
			return;
		}
		if (!['--source', '--out', '--verify'].includes(arg) || seen.has(arg) || !args[i + 1] || args[i + 1].startsWith('--')) {
			throw new Error(`Invalid D producer option: ${arg}`);
		}
		seen.add(arg);
		options[arg === '--source' ? 'sourceDir' : arg === '--out' ? 'outputDir' : 'verify'] = path.resolve(args[++i]);
	}
	if (options.verify && (seen.has('--source') || seen.has('--out'))) throw new Error('--verify cannot be combined with packaging');
	const receipt = options.verify ? await verifyDArtifacts(options.verify) : await packageD(options);
	console.log(`${options.verify ? 'Verified' : 'Packaged'} ${receipt.producerId}: ${receipt.artifacts.length} pinned artifacts`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
