#!/usr/bin/env node

import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { PACKAGED_PTHREAD_WORKER } from './build.mjs';
import { isMain } from './shared.mjs';
import { verifyWamrBrowser } from './verify.mjs';

export const WAMR_RUNTIME_ASSETS = Object.freeze([
	'wamr-debug.js',
	'wamr-debug.wasm',
	PACKAGED_PTHREAD_WORKER,
	'wamr-debug.wasm.gz'
]);

function indexAssets(receipt) {
	const assets = new Map();
	for (const asset of receipt.assets ?? []) {
		if (assets.has(asset.path)) {
			throw new Error(`duplicate WAMR browser asset metadata for ${asset.path}`);
		}
		assets.set(asset.path, asset);
	}
	return assets;
}

export function assertReproducibleWamrBuilds(first, second) {
	const { assets: firstAssetList, ...firstReceipt } = first;
	const { assets: secondAssetList, ...secondReceipt } = second;
	if (!isDeepStrictEqual(firstReceipt, secondReceipt)) {
		throw new Error('WAMR browser build receipt provenance differs');
	}
	const firstAssets = indexAssets({ assets: firstAssetList });
	const secondAssets = indexAssets({ assets: secondAssetList });
	if (
		firstAssets.size !== WAMR_RUNTIME_ASSETS.length ||
		secondAssets.size !== WAMR_RUNTIME_ASSETS.length ||
		WAMR_RUNTIME_ASSETS.some(
			(asset) => !firstAssets.has(asset) || !secondAssets.has(asset)
		)
	) {
		throw new Error('WAMR browser build asset set differs');
	}
	for (const asset of WAMR_RUNTIME_ASSETS) {
		if (!isDeepStrictEqual(firstAssets.get(asset), secondAssets.get(asset))) {
			throw new Error(`${asset} metadata differs between clean builds`);
		}
	}
}

export async function verifyReproducibleWamrArtifactDirectories(
	firstDirectory,
	secondDirectory
) {
	const firstPath = path.resolve(firstDirectory);
	const secondPath = path.resolve(secondDirectory);
	if (firstPath === secondPath) {
		throw new Error('reproducibility comparison requires two directories');
	}
	const [first, second] = await Promise.all([
		verifyWamrBrowser({ artifacts: firstPath }),
		verifyWamrBrowser({ artifacts: secondPath })
	]);
	assertReproducibleWamrBuilds(first, second);
	return first;
}

async function main() {
	const argumentsList = process.argv
		.slice(2)
		.filter((argument) => argument !== '--');
	if (argumentsList.includes('--help') || argumentsList.includes('-h')) {
		console.log(
			'Usage: node producer/wamr-browser/scripts/verify-reproducibility.mjs FIRST_ARTIFACT_DIR SECOND_ARTIFACT_DIR'
		);
		return;
	}
	if (argumentsList.length !== 2) {
		throw new Error('verify-reproducibility.mjs requires two artifact directories');
	}
	const receipt = await verifyReproducibleWamrArtifactDirectories(
		argumentsList[0],
		argumentsList[1]
	);
	const assets = indexAssets(receipt);
	const hashes = Object.fromEntries(
		WAMR_RUNTIME_ASSETS.map((asset) => [asset, assets.get(asset).sha256])
	);
	console.log(`Verified reproducible WAMR browser artifacts: ${JSON.stringify(hashes)}`);
}

if (isMain(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
