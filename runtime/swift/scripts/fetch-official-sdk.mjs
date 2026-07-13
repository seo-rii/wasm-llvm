#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	OFFICIAL_WASM_SDK_CHECKSUM,
	OFFICIAL_WASM_SDK_URL
} from './probe-toolchain.mjs';
import { validateSwiftSdkArchiveBytes } from './runtime-manifest.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const RUNTIME_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const DEFAULT_OUTPUT_PATH = path.join(RUNTIME_ROOT, 'raw-runtime', 'sdk.tar.gz');

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

export function validateSwiftWasmSdkArtifactUrl(url) {
	return (
		typeof url === 'string' &&
		/^https:\/\/download\.swift\.org\/.+\/[A-Za-z0-9._+-]+_wasm\.artifactbundle\.tar\.gz$/u.test(
			url
		)
	);
}

function readOptionValue(argv, index, optionName) {
	const value = argv[index + 1];
	if (typeof value !== 'string' || !value || value.startsWith('--')) {
		throw new Error(`${optionName} requires a value`);
	}
	return value;
}

export function parseFetchOfficialSdkArgs(argv) {
	const options = {
		outputPath: DEFAULT_OUTPUT_PATH,
		url: OFFICIAL_WASM_SDK_URL,
		checksum: OFFICIAL_WASM_SDK_CHECKSUM
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--') {
			continue;
		} else if (arg === '--help') {
			return { help: true };
		} else if (arg === '--output') {
			options.outputPath = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--url') {
			options.url = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--checksum') {
			options.checksum = readOptionValue(argv, index, arg);
			index += 1;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

export async function fetchSwiftWasmSdkArtifact({
	outputPath = DEFAULT_OUTPUT_PATH,
	url = OFFICIAL_WASM_SDK_URL,
	checksum = OFFICIAL_WASM_SDK_CHECKSUM,
	fetchImpl = globalThis.fetch
} = {}) {
	if (typeof fetchImpl !== 'function') throw new Error('fetch is not available in this Node.js runtime');
	if (!validateSwiftWasmSdkArtifactUrl(url)) {
		throw new Error('url must be a Swift.org Wasm SDK artifact bundle HTTPS URL');
	}
	if (typeof checksum !== 'string' || !/^[a-f0-9]{64}$/u.test(checksum)) {
		throw new Error('checksum must be a lowercase sha256 hex digest');
	}
	const response = await fetchImpl(url);
	if (!response?.ok) {
		throw new Error(`Swift Wasm SDK artifact download failed: HTTP ${response?.status ?? 'unknown'}`);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	const actualChecksum = sha256(bytes);
	if (actualChecksum !== checksum) {
		throw new Error(
			`Swift Wasm SDK artifact checksum mismatch: expected ${checksum}, actual ${actualChecksum}`
		);
	}
	const archiveErrors = validateSwiftSdkArchiveBytes(bytes);
	if (archiveErrors.length > 0) {
		throw new Error(`Swift Wasm SDK artifact is invalid:\n${archiveErrors.join('\n')}`);
	}
	const resolvedOutputPath = path.resolve(outputPath);
	await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
	await writeFile(resolvedOutputPath, bytes);
	return {
		bytes: bytes.byteLength,
		checksum: actualChecksum,
		outputPath: resolvedOutputPath,
		url
	};
}

function usage() {
	return [
		'Usage: pnpm --dir runtime/swift run fetch:official-sdk -- [--output path/to/sdk.tar.gz]',
		'',
		'Downloads the documented Swift.org Wasm SDK artifact, verifies its SHA-256 checksum,',
		'and writes it as the sdk.tar.gz input expected by package:wasm-swift.',
		'Use --url and --checksum only for another Swift.org artifact that should be recorded',
		'in runtime-build.json provenance.'
	].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		const options = parseFetchOfficialSdkArgs(process.argv.slice(2));
		if (options.help) {
			console.log(usage());
		} else {
			const result = await fetchSwiftWasmSdkArtifact(options);
			console.log(
				`Fetched Swift Wasm SDK artifact to ${result.outputPath} (${result.bytes} bytes, sha256 ${result.checksum})`
			);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
