#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { loadMemfsReleaseFiles } from './memfs-provenance.mjs';
import { readTarEntries } from '../../../scripts/lib/tar.mjs';
import { readClangZip, assertWasm, MAX_CLANG_ASSET_BYTES } from './archive-contract.mjs';
import { assertClangdStdinBridge } from './clangd-artifact-contract.mjs';
import {
	CLANGD_HEADER_ASSET,
	validateClangdHeaderMetadata,
	verifyClangdHeaderAsset
} from './clangd-header-asset-contract.mjs';

const gunzipAsync = promisify(gunzip);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const artifactDir = path.resolve(
	process.env.WASM_LLVM_CLANG_ARTIFACT_DIR || path.join(repoRoot, 'artifacts', 'clang-browser')
);
const requiredAssets = [
	'clang.zip',
	'lld.zip',
	'memfs.zip',
	'sysroot.tar.zip',
	'clangd/clangd.js',
	'clangd/clangd.wasm.gz'
];

function sha256(bytes) {
	return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function verifyClangProducerManifest(metadata, producerManifestBytes) {
	const producerManifest = JSON.parse(producerManifestBytes);
	let manifestCompatibility = 'current';
	if (metadata.producer?.id !== producerManifest.producerId ||
		metadata.producer?.manifest !== 'producer/clang-browser/manifest.json')
		throw new Error('Invalid Clang producer identity');
	if (metadata.producer.manifestSha256 !== sha256(producerManifestBytes)) {
		// Preserve historical provenance rather than relabelling old binaries.
		// These exact snapshots cover only the known MemFS rebuild and additive
		// optional headers. The MemFS transition also requires its current receipt
		// and delivered bytes to pass loadMemfsReleaseFiles below.
		const compatibilityDir = path.join(repoRoot, 'producer/clang-browser/compatibility');
		const beforeHeaders = await fs.readFile(path.join(compatibilityDir, 'manifest-before-optional-headers.json'));
		const beforeMemfs = await fs.readFile(path.join(compatibilityDir, 'manifest-before-memfs-rebuild.json'));
		const headersHash = '747c4158e33532b3ede5048abb87015a709e432a9adf66d644db75da36784864';
		const memfsHash = 'cc92f3c057a177288e7e11c06092aed47a7484e9ca6551f5c5413bb11b820d78';
		const { optionalOutputs, ...requiredManifest } = producerManifest;
		const previousManifest = JSON.parse(beforeMemfs);
		previousManifest.sources.memfs = JSON.parse(beforeHeaders).sources.memfs;
		if (sha256(beforeHeaders) !== headersHash || sha256(beforeMemfs) !== memfsHash ||
			!isDeepStrictEqual(previousManifest, JSON.parse(beforeHeaders)) ||
			metadata.clangd?.headers !== undefined ||
			!isDeepStrictEqual(optionalOutputs, ['clangd/clangd.headers.json.gz']) ||
			!isDeepStrictEqual(requiredManifest, JSON.parse(beforeHeaders)) ||
			![headersHash, memfsHash].includes(metadata.producer.manifestSha256) ||
			(metadata.producer.manifestSha256 === memfsHash && !metadata.memfs?.buildReceipt))
			throw new Error('Clang producer manifest mismatch: rebuild/repackage against the current pinned manifest');
		manifestCompatibility = metadata.producer.manifestSha256 === memfsHash
			? 'historical-components-requalified' : 'historical-compatible';
	}
	return manifestCompatibility;
}

export async function loadVerifiedClangArtifacts(directory = artifactDir) {
	const metadataPath = path.join(directory, 'toolchain.json');
	const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
	if (
		!metadata ||
		typeof metadata !== 'object' ||
		!metadata.assets ||
		typeof metadata.assets !== 'object' ||
		Array.isArray(metadata.assets)
	) {
		throw new Error(`Invalid toolchain metadata: ${metadataPath}`);
	}
	const producerManifestPath = path.join(repoRoot, 'producer/clang-browser/manifest.json');
	const producerManifestBytes = await fs.readFile(producerManifestPath);
	const manifestCompatibility = await verifyClangProducerManifest(metadata, producerManifestBytes);
	const assets = [...requiredAssets];
	if (metadata.clangd?.headers !== undefined) {
		validateClangdHeaderMetadata(metadata.clangd.headers);
		if (metadata.clangd.headers.resourceDir !== metadata.resourceDir)
			throw new Error('clangd header resource directory does not match the toolchain');
		assets.push(CLANGD_HEADER_ASSET);
	}
	if (
		Object.keys(metadata.assets).length !== assets.length ||
		assets.some((asset) => !Object.hasOwn(metadata.assets, asset))
	)
		throw new Error(
			'Toolchain metadata does not describe the complete Clang producer asset set'
		);

	const files = new Map();
	for (const asset of assets) {
		const assetPath = path.join(directory, asset);
		const bytes = await fs.readFile(assetPath);
		if (bytes.byteLength === 0) throw new Error(`Empty asset: ${asset}`);
		const expectedHash = metadata.assets[asset];
		if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
			throw new Error(`Missing hash for asset: ${asset}`);
		}
		const actualHash = sha256(bytes);
		if (actualHash !== expectedHash) {
			throw new Error(
				`Hash mismatch for ${asset}: expected ${expectedHash}, got ${actualHash}`
			);
		}
		files.set(asset, bytes);
		if (asset.endsWith('.zip')) {
			const name = asset.slice(0, -4);
			const raw = await readClangZip(bytes, name);
			if (name === 'sysroot.tar') readTarEntries(raw);
			else await assertWasm(name, raw);
		}
	}

	await assertClangdStdinBridge(
		files.get('clangd/clangd.js'),
		await gunzipAsync(files.get('clangd/clangd.wasm.gz'), { maxOutputLength: MAX_CLANG_ASSET_BYTES })
	);
	if (metadata.clangd?.headers !== undefined)
		verifyClangdHeaderAsset(
			files.get(CLANGD_HEADER_ASSET),
			metadata.clangd.headers
		);
	const sidecars = metadata.memfs === undefined ? new Map() :
		await loadMemfsReleaseFiles(directory, metadata.memfs, files.get('memfs.zip'));
	return { metadata, files, sidecars, manifestCompatibility };
}

export async function verifyClangArtifacts(directory = artifactDir) {
	const { files } = await loadVerifiedClangArtifacts(directory);
	return { assets: files.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const result = await loadVerifiedClangArtifacts();
	console.log(`Verified ${result.files.size} Clang producer artifacts in ${artifactDir} (manifest: ${result.manifestCompatibility})`);
}
