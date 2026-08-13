#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(THIS_FILE);
const PRODUCER_ROOT = path.resolve(SCRIPT_DIR, '..');

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function assertPinnedSource(receipt, key, pinnedSource) {
	if (receipt[key]?.commit !== pinnedSource.commit) {
		throw new Error(
			`Objective-C receipt ${key} commit does not match producer manifest: ${receipt[key]?.commit || '<missing>'}`
		);
	}
}

export async function finalizeObjectiveCReceipt({
	outputDir,
	foundationSourceCount,
	usesLibffi
}) {
	const manifestPath = path.join(PRODUCER_ROOT, 'manifest.json');
	const manifestBytes = await readFile(manifestPath);
	const manifest = JSON.parse(manifestBytes.toString('utf8'));
	const receiptPath = path.join(outputDir, 'producer-receipt.json');
	const existingReceipt = JSON.parse(await readFile(receiptPath, 'utf8'));
	const clangVersion = existingReceipt.toolchain?.clangVersion?.split(/\r?\n/, 1)[0];
	if (!clangVersion) {
		throw new Error('Objective-C receipt is missing the Clang version');
	}

	assertPinnedSource(existingReceipt, 'libobjc2', manifest.sources.libobjc2);
	assertPinnedSource(existingReceipt, 'robinMap', manifest.sources.robinMap);
	if (!Number.isInteger(foundationSourceCount) || foundationSourceCount <= 0) {
		throw new Error('Foundation source count must be a positive integer');
	}

	const assetNames = [
		'libobjc.a',
		'headers.json',
		'libgnustep-base.a',
		'libgnustep-base.o',
		'foundation-headers.json',
		...(usesLibffi ? ['libffi.a'] : [])
	];
	const assets = {};
	for (const assetName of assetNames) {
		const assetPath = path.join(outputDir, assetName);
		const bytes = await readFile(assetPath);
		assets[assetName] = {
			bytes: (await stat(assetPath)).size,
			sha256: sha256(bytes)
		};
	}

	const receipt = {
		...existingReceipt,
		producer: {
			id: manifest.producerId,
			manifest: 'producer/objective-c-browser/manifest.json',
			manifestSha256: sha256(manifestBytes)
		},
		toolchain: {
			wasiSdkVersion: manifest.toolchain.wasiSdkVersion,
			clangVersion
		},
		gnustepBase: {
			url: manifest.sources.gnustepBase.repository,
			ref: manifest.sources.gnustepBase.ref,
			commit: manifest.sources.gnustepBase.commit
		},
		libffi: usesLibffi
			? {
					url: manifest.sources.libffi.repository,
					ref: manifest.sources.libffi.ref,
					commit: manifest.sources.libffi.commit
				}
			: null,
		foundation: {
			sourceCount: foundationSourceCount,
			usesLibffi
		},
		assets
	};

	await writeFile(receiptPath, `${JSON.stringify(receipt, null, '\t')}\n`);
	return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	const outputDir = path.resolve(
		process.env.WASM_LLVM_OBJECTIVE_C_OUTPUT_DIR ||
			path.join(PRODUCER_ROOT, '..', '..', 'out', 'objective-c-browser')
	);
	const sourceCountIndex = process.argv.indexOf('--foundation-source-count');
	const foundationSourceCount = Number(process.argv[sourceCountIndex + 1] || '0');
	await finalizeObjectiveCReceipt({
		outputDir,
		foundationSourceCount,
		usesLibffi: !process.argv.includes('--without-libffi')
	});
	console.log(`Wrote complete Objective-C producer receipt in ${outputDir}`);
}
