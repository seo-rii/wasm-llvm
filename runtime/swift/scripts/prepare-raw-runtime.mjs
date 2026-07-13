#!/usr/bin/env node
import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchSwiftWasmSdkArtifact } from './fetch-official-sdk.mjs';
import {
	REQUIRED_RUNTIME_FILES,
	validateSwiftRunnerWorkerSource,
	validateSwiftRuntimeFileSignatures
} from './runtime-manifest.mjs';
import {
	OFFICIAL_WASM_SDK_CHECKSUM,
	OFFICIAL_WASM_SDK_URL
} from './probe-toolchain.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const RUNTIME_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const DEFAULT_SOURCE_DIR = path.join(RUNTIME_ROOT, 'raw-runtime');

const INPUT_FILE_OPTIONS = {
	'--runner-worker': 'runner-worker.js',
	'--swiftc-wasm': 'swiftc.wasm',
	'--swiftpm-wasm': 'swiftpm.wasm',
	'--sdk-archive': 'sdk.tar.gz'
};

async function fileExists(filePath) {
	const fileStats = await stat(filePath).catch(() => null);
	return !!fileStats?.isFile();
}

function readOptionValue(argv, index, optionName) {
	const value = argv[index + 1];
	if (typeof value !== 'string' || !value || value.startsWith('--')) {
		throw new Error(`${optionName} requires a value`);
	}
	return value;
}

export function parsePrepareRawRuntimeArgs(argv) {
	const options = {
		sourceDir: DEFAULT_SOURCE_DIR,
		inputs: {},
		fetchOfficialSdk: false,
		sdkUrl: OFFICIAL_WASM_SDK_URL,
		sdkChecksum: OFFICIAL_WASM_SDK_CHECKSUM,
		allowIncomplete: false
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--') {
			continue;
		} else if (arg === '--help') {
			return { help: true };
		} else if (arg === '--source-dir') {
			options.sourceDir = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--fetch-official-sdk') {
			options.fetchOfficialSdk = true;
		} else if (arg === '--sdk-url') {
			options.sdkUrl = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--sdk-checksum') {
			options.sdkChecksum = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--allow-incomplete') {
			options.allowIncomplete = true;
		} else if (Object.hasOwn(INPUT_FILE_OPTIONS, arg)) {
			options.inputs[INPUT_FILE_OPTIONS[arg]] = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

export async function prepareSwiftRawRuntime({
	sourceDir = DEFAULT_SOURCE_DIR,
	inputs = {},
	fetchOfficialSdk = false,
	sdkUrl = OFFICIAL_WASM_SDK_URL,
	sdkChecksum = OFFICIAL_WASM_SDK_CHECKSUM,
	allowIncomplete = false,
	fetchImpl = globalThis.fetch
} = {}) {
	const normalizedSourceDir = path.resolve(sourceDir);
	await mkdir(normalizedSourceDir, { recursive: true });

	for (const [relativePath, inputPath] of Object.entries(inputs)) {
		if (!REQUIRED_RUNTIME_FILES.includes(relativePath)) {
			throw new Error(`Unsupported Swift runtime input target: ${relativePath}`);
		}
		await cp(path.resolve(inputPath), path.join(normalizedSourceDir, relativePath));
	}

	if (fetchOfficialSdk) {
		await fetchSwiftWasmSdkArtifact({
			outputPath: path.join(normalizedSourceDir, 'sdk.tar.gz'),
			url: sdkUrl,
			checksum: sdkChecksum,
			fetchImpl
		});
	}

	const missing = [];
	for (const relativePath of REQUIRED_RUNTIME_FILES) {
		if (!(await fileExists(path.join(normalizedSourceDir, relativePath)))) {
			missing.push(relativePath);
		}
	}
	if (missing.length > 0) {
		if (allowIncomplete) {
			return { sourceDir: normalizedSourceDir, ready: false, missing };
		}
		throw new Error(
			`Swift raw runtime is incomplete in ${normalizedSourceDir}: missing ${missing.join(', ')}`
		);
	}

	const runnerErrors = validateSwiftRunnerWorkerSource(
		await readFile(path.join(normalizedSourceDir, 'runner-worker.js'), 'utf8')
	);
	const signatureErrors = await validateSwiftRuntimeFileSignatures(normalizedSourceDir);
	const errors = [...runnerErrors, ...signatureErrors];
	if (errors.length > 0) {
		throw new Error(`Swift raw runtime is not packageable:\n${errors.join('\n')}`);
	}
	return { sourceDir: normalizedSourceDir, ready: true, missing: [] };
}

function usage() {
	return [
		'Usage: pnpm --dir runtime/swift run prepare:raw-runtime -- [options]',
		'',
		'Options:',
		'  --source-dir <dir>          Raw runtime directory to create or update',
		'  --runner-worker <file>      Browser Swift runner worker source',
		'  --swiftc-wasm <file>        Browser-hosted Swift compiler wasm',
		'  --swiftpm-wasm <file>       Browser-hosted SwiftPM wasm',
		'  --sdk-archive <file>        Swift Wasm SDK archive to store as sdk.tar.gz',
		'  --fetch-official-sdk        Download the documented Swift.org SDK archive',
		'  --sdk-url <url>             Override the SDK artifact URL for --fetch-official-sdk',
		'  --sdk-checksum <sha256>     Override the SDK artifact checksum for --fetch-official-sdk',
		'  --allow-incomplete          Create/copy what is available without failing on missing files',
		'',
		'The command only prepares and validates the raw browser runtime input. It does not',
		'build swiftc.wasm or swiftpm.wasm.'
	].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		const options = parsePrepareRawRuntimeArgs(process.argv.slice(2));
		if (options.help) {
			console.log(usage());
		} else {
			const result = await prepareSwiftRawRuntime(options);
			if (result.ready) {
				console.log(`Swift raw runtime is packageable: ${result.sourceDir}`);
			} else {
				console.log(
					`Swift raw runtime prepared but incomplete: ${result.sourceDir}; missing ${result.missing.join(', ')}`
				);
			}
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
