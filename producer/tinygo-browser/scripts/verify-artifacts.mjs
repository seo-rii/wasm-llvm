#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	loadTinyGoProducerContract,
	sha256,
	validateTinyGoCompilerReceipt,
	validateTinyGoSourceReceipt
} from './source-contract.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

export function verifyTinyGoArtifactPayloads({ compilerBytes, tinygoRootBytes, manifest }) {
	assert(
		compilerBytes instanceof Uint8Array && WebAssembly.validate(compilerBytes),
		'tinygo-compiler.wasm is not valid WebAssembly'
	);
	const compilerImports = WebAssembly.Module.imports(
		new WebAssembly.Module(compilerBytes)
	);
	const nonWasiImports = compilerImports.filter(
		(entry) => entry.module !== 'wasi_snapshot_preview1'
	);
	assert(
		nonWasiImports.length === 0,
		`tinygo-compiler.wasm contains non-WASI imports: ${nonWasiImports
			.map((entry) => `${entry.module}.${entry.name}`)
			.join(', ')}`
	);
	for (const identity of manifest.upstreamCompiler.requiredArtifactIdentityStrings) {
		assert(
			Buffer.from(compilerBytes).includes(Buffer.from(identity)),
			`tinygo-compiler.wasm is missing upstream compiler identity ${identity}`
		);
	}
	for (const forbidden of manifest.upstreamCompiler.forbiddenArtifactIdentityStrings) {
		assert(
			!Buffer.from(compilerBytes).includes(Buffer.from(forbidden)),
			`tinygo-compiler.wasm contains forbidden custom compiler identity ${forbidden}`
		);
	}
	assert(
		tinygoRootBytes?.[0] === 0x1f && tinygoRootBytes?.[1] === 0x8b,
		'tinygoroot.tar.gz is not a gzip archive'
	);
}

export async function verifyTinyGoCompilerArtifacts({
	artifactDir,
	sourceReceiptPath,
	producerRoot,
	contract: suppliedContract = null,
	requireReady = true
}) {
	const contract = suppliedContract ?? (await loadTinyGoProducerContract(producerRoot));
	if (requireReady) {
		assert(
			contract.manifest?.readiness?.ready === true,
			`TinyGo browser compiler readiness is blocked: ${contract.manifest?.readiness?.blockedOn ?? 'no upstream compiler build is recorded'}`
		);
	}
	const sourceReceiptBytes = await readFile(sourceReceiptPath);
	const sourceReceipt = JSON.parse(sourceReceiptBytes);
	validateTinyGoSourceReceipt(sourceReceipt, contract);

	const compilerReceiptPath = path.join(artifactDir, 'producer-receipt.json');
	const compilerReceipt = JSON.parse(await readFile(compilerReceiptPath, 'utf8'));
	validateTinyGoCompilerReceipt(compilerReceipt, {
		manifest: contract.manifest,
		lock: contract.lock,
		sourceReceipt,
		acceptance: contract.acceptance,
		manifestSha256: contract.inputs.manifestSha256,
		sourcesLockSha256: contract.inputs.sourcesLockSha256,
		sourceReceiptSha256: sha256(sourceReceiptBytes)
	});

	const assetBytes = new Map();
	for (const asset of compilerReceipt.assets) {
		const bytes = await readFile(path.join(artifactDir, asset.path));
		assert(bytes.length === asset.bytes, `${asset.path} size does not match producer receipt`);
		assert(sha256(bytes) === asset.sha256, `${asset.path} hash does not match producer receipt`);
		assetBytes.set(asset.path, bytes);
	}
	verifyTinyGoArtifactPayloads({
		compilerBytes: assetBytes.get('tinygo-compiler.wasm'),
		tinygoRootBytes: assetBytes.get('tinygoroot.tar.gz'),
		manifest: contract.manifest
	});
	return { compilerReceipt, sourceReceipt };
}

export function parseVerifyArtifactArgs(argv) {
	if (argv.includes('--help') || argv.includes('-h')) return { help: true };
	if (argv.length !== 2 || argv.some((argument) => argument.startsWith('-'))) {
		throw new Error('Expected ARTIFACT_DIR and SOURCE_RECEIPT');
	}
	return {
		help: false,
		artifactDir: path.resolve(argv[0]),
		sourceReceiptPath: path.resolve(argv[1])
	};
}

async function main(argv = process.argv.slice(2)) {
	const options = parseVerifyArtifactArgs(argv);
	if (options.help) {
		console.log(
			'Usage: node scripts/verify-artifacts.mjs ARTIFACT_DIR SOURCE_RECEIPT\n\n' +
				'Strictly verifies source-lock provenance, upstream package identity, output hashes,\n' +
				'WebAssembly structure, TinyGo rootfs format, and the absence of custom wasmbridge code.'
		);
		return;
	}
	const result = await verifyTinyGoCompilerArtifacts(options);
	console.log(`Verified ${result.compilerReceipt.assets.length} upstream TinyGo compiler assets`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
