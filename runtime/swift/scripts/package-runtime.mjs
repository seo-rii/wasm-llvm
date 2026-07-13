#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	BUILD_PLAN_SNAPSHOT_FILE,
	BROWSER_BUILD_LOG_SNAPSHOT_FILE,
	SOURCE_BOOTSTRAP_RECEIPT_SNAPSHOT_FILE,
	WORKFLOW_PREFLIGHT_RECEIPT_SNAPSHOT_FILE,
	createSwiftRuntimeBuildInfo,
	validateSwiftRuntimeBuildInfo,
	validateSwiftRuntimeSdkChecksum
} from './runtime-build-info.mjs';
import { validateSwiftRuntimeBundleInBrowser } from './runtime-contract-runner.mjs';
import {
	OFFICIAL_SWIFT_VERSION,
	OFFICIAL_WASM_SDK_CHECKSUM,
	OFFICIAL_WASM_SDK_ID,
	OFFICIAL_WASM_SDK_URL
} from './probe-toolchain.mjs';
import {
	buildFileEntries,
	createSwiftRuntimeManifest,
	fingerprintFileEntries,
	REQUIRED_RUNTIME_FILES,
	validateSwiftRuntimeManifest,
	validateSwiftRuntimeManifestFiles,
	validateSwiftRunnerWorkerSource,
	validateSwiftRuntimeFileSignatures
} from './runtime-manifest.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const RUNTIME_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const DEFAULT_DIST_DIR = path.join(RUNTIME_ROOT, 'dist');
const OPTIONAL_SOURCE_FILES = [
	'LICENSE',
	'README.md',
	'SOURCE.txt',
	BUILD_PLAN_SNAPSHOT_FILE,
	BROWSER_BUILD_LOG_SNAPSHOT_FILE,
	WORKFLOW_PREFLIGHT_RECEIPT_SNAPSHOT_FILE,
	SOURCE_BOOTSTRAP_RECEIPT_SNAPSHOT_FILE
];
const BASELINE_RECEIPT_SNAPSHOT_PATTERN = /^upstream-baseline-[A-Za-z0-9._+-]+\.snapshot\.json$/u;

async function fileExists(filePath) {
	const fileStats = await stat(filePath).catch(() => null);
	return !!fileStats?.isFile();
}

async function resolveSourceRuntimeFile(sourceDir, relativePath) {
	const sourcePath = path.join(sourceDir, relativePath);
	if (await fileExists(sourcePath)) return { sourcePath, targetPath: relativePath };
	if (relativePath.endsWith('.wasm')) {
		const compressedPath = `${sourcePath}.gz`;
		if (await fileExists(compressedPath)) {
			return { sourcePath: compressedPath, targetPath: `${relativePath}.gz` };
		}
	}
	return null;
}

function requiredOption(options, name) {
	const value = options[name];
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`${name} is required`);
	}
	return value;
}

async function copyIfPresent(sourceDir, distDir, relativePath) {
	const sourcePath = path.join(sourceDir, relativePath);
	if (await fileExists(sourcePath)) {
		await cp(sourcePath, path.join(distDir, relativePath));
	}
}

async function copyOptionalSourceFiles(sourceDir, distDir) {
	for (const relativePath of OPTIONAL_SOURCE_FILES) {
		await copyIfPresent(sourceDir, distDir, relativePath);
	}
	for (const entry of await readdir(sourceDir, { withFileTypes: true }).catch(() => [])) {
		if (entry.isFile() && BASELINE_RECEIPT_SNAPSHOT_PATTERN.test(entry.name)) {
			await cp(path.join(sourceDir, entry.name), path.join(distDir, entry.name));
		}
	}
}

async function assertPackagedDist(distDir) {
	const runnerWorkerPath = path.join(distDir, 'runner-worker.js');
	const runnerErrors = validateSwiftRunnerWorkerSource(
		await readFile(runnerWorkerPath, 'utf8')
	);
	if (runnerErrors.length > 0) {
		throw new Error(
			`Swift runner-worker.js does not match the playground contract:\n${runnerErrors.join('\n')}`
		);
	}
	const signatureErrors = await validateSwiftRuntimeFileSignatures(distDir);
	if (signatureErrors.length > 0) {
		throw new Error(`Swift runtime assets have invalid file signatures:\n${signatureErrors.join('\n')}`);
	}
}

async function assertSourceBundle(sourceDir) {
	for (const relativePath of REQUIRED_RUNTIME_FILES) {
		if (!(await resolveSourceRuntimeFile(sourceDir, relativePath))) {
			const suffix = relativePath.endsWith('.wasm') ? ` or ${relativePath}.gz` : '';
			throw new Error(
				`Swift runtime source asset ${relativePath}${suffix} was not found in ${sourceDir}.`
			);
		}
	}
	const runnerErrors = validateSwiftRunnerWorkerSource(
		await readFile(path.join(sourceDir, 'runner-worker.js'), 'utf8')
	);
	if (runnerErrors.length > 0) {
		throw new Error(
			`Swift source runner-worker.js does not match the playground contract:\n${runnerErrors.join('\n')}`
		);
	}
	const signatureErrors = await validateSwiftRuntimeFileSignatures(sourceDir);
	if (signatureErrors.length > 0) {
		throw new Error(`Swift runtime source assets have invalid file signatures:\n${signatureErrors.join('\n')}`);
	}
}

async function assertSdkChecksum(sourceDir, buildInfo) {
	const errors = await validateSwiftRuntimeSdkChecksum(buildInfo, {
		bundleDir: sourceDir,
		messagePrefix: 'Swift runtime build metadata '
	});
	if (errors.length > 0) {
		throw new Error(errors.join('\n'));
	}
}

async function createPackageTempDir(distDir) {
	const parentDir = path.dirname(distDir);
	await mkdir(parentDir, { recursive: true });
	return mkdtemp(path.join(parentDir, '.wasm-swift-dist-'));
}

async function writePackagedDist(sourceDir, distDir, buildInfo) {
	await mkdir(distDir, { recursive: true });
	for (const relativePath of REQUIRED_RUNTIME_FILES) {
		const resolved = await resolveSourceRuntimeFile(sourceDir, relativePath);
		if (!resolved) throw new Error(`Swift runtime source asset ${relativePath} was not found.`);
		await cp(resolved.sourcePath, path.join(distDir, resolved.targetPath));
	}
	await copyOptionalSourceFiles(sourceDir, distDir);
	await writeFile(
		path.join(distDir, 'runtime-build.json'),
		`${JSON.stringify(buildInfo, null, 2)}\n`,
		'utf8'
	);
	const files = await buildFileEntries(distDir);
	const fingerprint = fingerprintFileEntries(files);
	const manifest = createSwiftRuntimeManifest({
		files,
		swiftVersion: buildInfo.swiftVersion,
		wasmSdkId: buildInfo.wasmSdkId,
		fingerprint
	});
	const manifestErrors = validateSwiftRuntimeManifest(manifest);
	if (manifestErrors.length > 0) {
		throw new Error(`Swift packaged runtime manifest is invalid:\n${manifestErrors.join('\n')}`);
	}
	await writeFile(
		path.join(distDir, 'runtime-manifest.v1.json'),
		`${JSON.stringify(manifest, null, 2)}\n`,
		'utf8'
	);
	const manifestFileErrors = await validateSwiftRuntimeManifestFiles(distDir, manifest);
	if (manifestFileErrors.length > 0) {
		throw new Error(`Swift packaged runtime manifest files are invalid:\n${manifestFileErrors.join('\n')}`);
	}
	await assertPackagedDist(distDir);
	return { fingerprint, manifest };
}

function assertSafeOutputPath(sourceDir, distDir) {
	if (sourceDir === distDir) {
		throw new Error('distDir must be different from sourceDir');
	}
	if (sourceDir.startsWith(`${distDir}${path.sep}`)) {
		throw new Error('distDir must not be a parent directory of sourceDir');
	}
}

function assertTimeoutMs(timeoutMs) {
	if (
		timeoutMs !== undefined &&
		(!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
	) {
		throw new Error('timeoutMs must be a positive safe integer when provided');
	}
}

function readOptionValue(argv, index, optionName) {
	const value = argv[index + 1];
	if (typeof value !== 'string' || !value || value.startsWith('--')) {
		throw new Error(`${optionName} requires a value`);
	}
	return value;
}

function assertPackageProvenance(source) {
	if (typeof source !== 'string' || !source.trim()) {
		throw new Error('source is required to package a Swift runtime dist');
	}
}

function applyOfficialWasmSdkProvenance(options) {
	if (!options.officialWasmSdkProvenance) return options;
	if (options.swiftVersion !== OFFICIAL_SWIFT_VERSION || options.wasmSdkId !== OFFICIAL_WASM_SDK_ID) {
		throw new Error(
			`--official-wasm-sdk-provenance requires --swift-version ${OFFICIAL_SWIFT_VERSION} and --wasm-sdk-id ${OFFICIAL_WASM_SDK_ID}`
		);
	}
	if (options.wasmSdkUrl && options.wasmSdkUrl !== OFFICIAL_WASM_SDK_URL) {
		throw new Error(
			`--official-wasm-sdk-provenance cannot be combined with a non-official --wasm-sdk-url`
		);
	}
	if (options.wasmSdkChecksum && options.wasmSdkChecksum !== OFFICIAL_WASM_SDK_CHECKSUM) {
		throw new Error(
			`--official-wasm-sdk-provenance cannot be combined with a non-official --wasm-sdk-checksum`
		);
	}
	return {
		...options,
		wasmSdkUrl: OFFICIAL_WASM_SDK_URL,
		wasmSdkChecksum: OFFICIAL_WASM_SDK_CHECKSUM
	};
}

export async function packageSwiftRuntimeDist({
	sourceDir,
	distDir = DEFAULT_DIST_DIR,
	swiftVersion,
	wasmSdkId,
	wasmSdkUrl,
	wasmSdkChecksum,
	source,
	notes,
	runBrowserContract = false,
	officialWasmSdkProvenance = false,
	timeoutMs
} = {}) {
	const options = applyOfficialWasmSdkProvenance({
		swiftVersion,
		wasmSdkId,
		wasmSdkUrl,
		wasmSdkChecksum,
		officialWasmSdkProvenance
	});
	const normalizedSourceDir = path.resolve(requiredOption({ sourceDir }, 'sourceDir'));
	const normalizedDistDir = path.resolve(distDir);
	const sourceStats = await stat(normalizedSourceDir).catch(() => null);
	if (!sourceStats?.isDirectory()) {
		throw new Error(`Swift runtime package source directory was not found: ${normalizedSourceDir}`);
	}
	assertSafeOutputPath(normalizedSourceDir, normalizedDistDir);
	assertTimeoutMs(timeoutMs);
	assertPackageProvenance(source);
	const buildInfo = createSwiftRuntimeBuildInfo({
		swiftVersion: requiredOption({ swiftVersion: options.swiftVersion }, 'swiftVersion'),
		wasmSdkId: requiredOption({ wasmSdkId: options.wasmSdkId }, 'wasmSdkId'),
		wasmSdkUrl: options.wasmSdkUrl,
		wasmSdkChecksum: options.wasmSdkChecksum,
		source,
		notes
	});
	const buildInfoErrors = validateSwiftRuntimeBuildInfo(buildInfo);
	if (buildInfoErrors.length > 0) {
		throw new Error(`Swift runtime build metadata is invalid:\n${buildInfoErrors.join('\n')}`);
	}
	await assertSourceBundle(normalizedSourceDir);
	await assertSdkChecksum(normalizedSourceDir, buildInfo);

	let tempDistDir = await createPackageTempDir(normalizedDistDir);
	let packaged;
	try {
		packaged = await writePackagedDist(normalizedSourceDir, tempDistDir, buildInfo);
		if (runBrowserContract) {
			await validateSwiftRuntimeBundleInBrowser({
				bundleDir: tempDistDir,
				timeoutMs
			});
		}
		await rm(normalizedDistDir, { recursive: true, force: true });
		await rename(tempDistDir, normalizedDistDir);
		tempDistDir = '';
	} finally {
		if (tempDistDir) await rm(tempDistDir, { recursive: true, force: true });
	}
	return {
		sourceDir: normalizedSourceDir,
		distDir: normalizedDistDir,
		buildInfo,
		fingerprint: packaged.fingerprint,
		manifest: packaged.manifest
	};
}

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--') {
			continue;
		} else if (arg === '--help') {
			options.help = true;
		} else if (arg === '--source-dir') {
			options.sourceDir = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--dist-dir') {
			options.distDir = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--swift-version') {
			options.swiftVersion = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--wasm-sdk-id') {
			options.wasmSdkId = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--wasm-sdk-url') {
			options.wasmSdkUrl = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--wasm-sdk-checksum') {
			options.wasmSdkChecksum = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--official-wasm-sdk-provenance') {
			options.officialWasmSdkProvenance = true;
		} else if (arg === '--source') {
			options.source = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--notes') {
			options.notes = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--browser-contract') {
			options.runBrowserContract = true;
		} else if (arg === '--timeout-ms') {
			options.timeoutMs = Number(readOptionValue(argv, index, arg));
			index += 1;
			assertTimeoutMs(options.timeoutMs);
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

function usage() {
	return [
		'Usage: pnpm run package:wasm-swift -- --source-dir <dir> --swift-version <version> --wasm-sdk-id <sdk_id> --source <provenance>',
		'',
		'Packages a browser-hosted Swift compiler runtime into runtime/swift/dist.',
		'Required metadata: --source records upstream/build provenance for the packaged compiler bundle.',
		'Optional metadata: --wasm-sdk-url and --wasm-sdk-checksum record the Swift.org Wasm SDK artifact used by the bundle.',
		'Use --official-wasm-sdk-provenance with the documented official Swift/Wasm SDK to fill those fields automatically.',
		'Required source files: runner-worker.js, swiftc.wasm or swiftc.wasm.gz, swiftpm.wasm or swiftpm.wasm.gz, sdk.tar.gz.',
		'Gzip-only compiler inputs are preserved as compressed files while the manifest records logical .wasm paths.',
		'Use --browser-contract to run the staged bundle through Chromium before replacing dist.',
		'The --browser-contract path reuses the same required --source provenance.'
	].join('\n');
}

async function main(argv = process.argv.slice(2)) {
	const options = parseArgs(argv);
	if (options.help) {
		console.log(usage());
		return;
	}
	const result = await packageSwiftRuntimeDist(options);
	console.log(`Packaged wasm-swift runtime dist at ${result.distDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
