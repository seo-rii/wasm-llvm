#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	DEFAULT_MIN_SWIFT_BUILD_FREE_GIB,
	formatGiB,
	inspectFreeDiskSpace
} from './disk-space.mjs';
import {
	classifySwiftBrowserBuildCommand,
	validateSourceBootstrapReceipt
} from './build-browser-compiler.mjs';
import {
	validateSwiftCompilerWasmModuleBytes,
	validateSwiftRunnerWorkerSource,
	validateSwiftSdkArchiveBytes
} from './runtime-manifest.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const RUNTIME_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const DEFAULT_SOURCE_ROOT = path.join(RUNTIME_ROOT, 'source-checkout');
const DEFAULT_BUILD_DIR = path.join(RUNTIME_ROOT, 'browser-compiler-build');

function readOptionValue(argv, index, optionName) {
	const value = argv[index + 1];
	if (typeof value !== 'string' || value.startsWith('--')) {
		throw new Error(`${optionName} requires a value`);
	}
	return value;
}

function parseBoolean(value, optionName) {
	if (value === true || value === 'true') return true;
	if (value === false || value === 'false') return false;
	throw new Error(`${optionName} must be true or false`);
}

async function fileExists(filePath) {
	const stats = await stat(filePath).catch(() => null);
	return !!stats?.isFile();
}

async function directoryExists(dirPath) {
	const stats = await stat(dirPath).catch(() => null);
	return !!stats?.isDirectory();
}

async function validateExplicitOutputFile(name, filePath) {
	const normalizedPath = path.resolve(filePath);
	const bytes = await readFile(normalizedPath).catch((error) => {
		throw new Error(`${name} file could not be read: ${error instanceof Error ? error.message : String(error)}`);
	});
	if (name === 'runner-worker') {
		return validateSwiftRunnerWorkerSource(bytes.toString('utf8'));
	}
	if (name === 'swiftc-wasm') {
		return validateSwiftCompilerWasmModuleBytes(bytes, 'swiftc.wasm');
	}
	if (name === 'swiftpm-wasm') {
		return validateSwiftCompilerWasmModuleBytes(bytes, 'swiftpm.wasm');
	}
	if (name === 'sdk-archive') {
		return validateSwiftSdkArchiveBytes(bytes, 'sdk.tar.gz');
	}
	return [];
}

export function parseSwiftWorkflowPreflightArgs(argv) {
	const options = {
		bootstrapSource: false,
		sourceRoot: DEFAULT_SOURCE_ROOT,
		buildDir: DEFAULT_BUILD_DIR,
		minFreeGiB: DEFAULT_MIN_SWIFT_BUILD_FREE_GIB
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--') {
			continue;
		} else if (arg === '--help') {
			return { help: true };
		} else if (arg === '--bootstrap-source') {
			options.bootstrapSource = parseBoolean(readOptionValue(argv, index, arg), arg);
			index += 1;
		} else if (arg === '--source-root') {
			options.sourceRoot = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--source-bootstrap-receipt') {
			options.sourceBootstrapReceipt = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--build-dir') {
			options.buildDir = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--min-free-gib') {
			options.minFreeGiB = Number(readOptionValue(argv, index, arg));
			if (!Number.isFinite(options.minFreeGiB) || options.minFreeGiB < 0) {
				throw new Error('--min-free-gib must be a non-negative number');
			}
			index += 1;
		} else if (arg === '--swift-clone-depth') {
			options.swiftCloneDepth = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--swift-clone-filter') {
			options.swiftCloneFilter = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--runner-worker') {
			options.runnerWorker = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--swiftc-wasm') {
			options.swiftcWasm = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--swiftpm-wasm') {
			options.swiftpmWasm = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--sdk-archive') {
			options.sdkArchive = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--browser-build-command') {
			options.browserBuildCommand = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--swift-version') {
			options.swiftVersion = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--wasm-sdk-id') {
			options.wasmSdkId = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--published-url') {
			options.publishedUrl = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--receipt') {
			options.receiptPath = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

function validateMetadata(options) {
	const errors = [];
	const hasSwiftCloneDepth =
		typeof options.swiftCloneDepth === 'string'
			? options.swiftCloneDepth.trim().length > 0
			: options.swiftCloneDepth !== undefined;
	const hasSwiftCloneFilter =
		typeof options.swiftCloneFilter === 'string'
			? options.swiftCloneFilter.trim().length > 0
			: options.swiftCloneFilter !== undefined;
	if (
		typeof options.swiftVersion !== 'string' ||
		!/^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/u.test(options.swiftVersion)
	) {
		errors.push('swift-version must be a Swift semantic version such as 6.3.3');
	}
	if (
		typeof options.wasmSdkId !== 'string' ||
		!/^[A-Za-z0-9._+-]+_wasm$/u.test(options.wasmSdkId)
	) {
		errors.push('wasm-sdk-id must be a full Swift Wasm SDK id ending in _wasm');
	}
	if (options.publishedUrl && !/^https?:\/\//u.test(options.publishedUrl)) {
		errors.push('published-url must be http(s) when provided');
	}
	if (
		hasSwiftCloneDepth &&
		(!/^\d+$/u.test(String(options.swiftCloneDepth)) || Number(options.swiftCloneDepth) <= 0)
	) {
		errors.push('swift-clone-depth must be a positive integer when provided');
	}
	if (
		hasSwiftCloneFilter &&
		(typeof options.swiftCloneFilter !== 'string' ||
			!/^[A-Za-z0-9:._=-]+$/u.test(options.swiftCloneFilter))
	) {
		errors.push('swift-clone-filter must be a non-empty git clone filter expression when provided');
	}
	return errors;
}

export async function checkSwiftWorkflowPreflight(options = {}) {
	const inspectDiskSpace = options.inspectDiskSpace ?? inspectFreeDiskSpace;
	const normalized = {
		...options,
		bootstrapSource: !!options.bootstrapSource,
		sourceRoot: path.resolve(options.sourceRoot ?? DEFAULT_SOURCE_ROOT),
		buildDir: path.resolve(options.buildDir ?? DEFAULT_BUILD_DIR),
		minFreeGiB: options.minFreeGiB ?? DEFAULT_MIN_SWIFT_BUILD_FREE_GIB
	};
	const errors = validateMetadata(normalized);
	let disk = null;

	try {
		disk = await inspectDiskSpace(normalized.buildDir, {
			minFreeGiB: normalized.minFreeGiB
		});
		if (!disk.ok) {
			errors.push(
				`build-dir does not have enough free space for Swift browser compiler work: ${disk.probePath} has ${formatGiB(disk.freeBytes)} GiB free; ${disk.minFreeGiB} GiB required`
			);
		}
	} catch (error) {
		errors.push(
			`build-dir free-space check failed for ${normalized.buildDir}: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
	}

	if (!normalized.bootstrapSource && !(await directoryExists(normalized.sourceRoot))) {
		errors.push(
			`source-root must already exist when bootstrap-source is false: ${normalized.sourceRoot}`
		);
	}
	if (
		!normalized.bootstrapSource &&
		(typeof normalized.sourceBootstrapReceipt !== 'string' ||
			!normalized.sourceBootstrapReceipt.trim())
	) {
		errors.push(
			'source-bootstrap-receipt is required when bootstrap-source is false so strict source bootstrap provenance can pass'
		);
	}
	if (
		!normalized.bootstrapSource &&
		typeof normalized.sourceBootstrapReceipt === 'string' &&
		normalized.sourceBootstrapReceipt.trim() &&
		(await fileExists(path.resolve(normalized.sourceBootstrapReceipt)))
	) {
		try {
			await validateSourceBootstrapReceipt(
				normalized.sourceBootstrapReceipt,
				normalized.sourceRoot
			);
		} catch (error) {
			errors.push(
				`source-bootstrap-receipt is invalid for workflow preflight: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	} else if (
		!normalized.bootstrapSource &&
		typeof normalized.sourceBootstrapReceipt === 'string' &&
		normalized.sourceBootstrapReceipt.trim()
	) {
		errors.push(
			`source-bootstrap-receipt file was not found: ${path.resolve(normalized.sourceBootstrapReceipt)}`
		);
	}
	const hasSwiftCloneDepth =
		typeof normalized.swiftCloneDepth === 'string'
			? normalized.swiftCloneDepth.trim().length > 0
			: normalized.swiftCloneDepth !== undefined;
	const hasSwiftCloneFilter =
		typeof normalized.swiftCloneFilter === 'string'
			? normalized.swiftCloneFilter.trim().length > 0
			: normalized.swiftCloneFilter !== undefined;
	if (!normalized.bootstrapSource && hasSwiftCloneDepth) {
		errors.push('swift-clone-depth can only be used when bootstrap-source is true');
	}
	if (!normalized.bootstrapSource && hasSwiftCloneFilter) {
		errors.push('swift-clone-filter can only be used when bootstrap-source is true');
	}
	const providedOutputs = [
		['runner-worker', normalized.runnerWorker],
		['swiftc-wasm', normalized.swiftcWasm],
		['swiftpm-wasm', normalized.swiftpmWasm]
	].filter(([, value]) => typeof value === 'string' && value.trim());
	const hasBrowserBuildCommand =
		typeof normalized.browserBuildCommand === 'string' &&
		normalized.browserBuildCommand.trim().length > 0;
	if (providedOutputs.length > 0 && providedOutputs.length !== 3) {
		errors.push('runner-worker, swiftc-wasm, and swiftpm-wasm must be provided together');
	}
	if (!hasBrowserBuildCommand) {
		errors.push(
			'browser-build-command is required so exported artifacts include browserCompilerBuild.command provenance'
		);
	} else {
		const browserBuildCommandClassification = classifySwiftBrowserBuildCommand(
			normalized.browserBuildCommand
		);
		if (!browserBuildCommandClassification.ok) {
			errors.push(browserBuildCommandClassification.error);
		}
	}
	for (const [name, filePath] of [
		['runner-worker', normalized.runnerWorker],
		['swiftc-wasm', normalized.swiftcWasm],
		['swiftpm-wasm', normalized.swiftpmWasm],
		['sdk-archive', normalized.sdkArchive]
	]) {
		if (typeof filePath === 'string' && filePath.trim()) {
			const normalizedFilePath = path.resolve(filePath);
			if (!(await fileExists(normalizedFilePath))) {
				errors.push(`${name} file was not found: ${normalizedFilePath}`);
			} else {
				try {
					const fileErrors = await validateExplicitOutputFile(name, normalizedFilePath);
					for (const fileError of fileErrors) {
						errors.push(`${name} is invalid: ${fileError}`);
					}
				} catch (error) {
					errors.push(
						`${name} validation failed for ${normalizedFilePath}: ${
							error instanceof Error ? error.message : String(error)
						}`
					);
				}
			}
		}
	}
	return {
		ok: errors.length === 0,
		errors,
		sourceRoot: normalized.sourceRoot,
		buildDir: normalized.buildDir,
		disk,
		receipt: createSwiftWorkflowPreflightReceipt(normalized, errors, disk)
	};
}

export function createSwiftWorkflowPreflightReceipt(options, errors = [], disk = null) {
	const explicitOutputPaths = Object.fromEntries(
		[
			['runnerWorker', options.runnerWorker],
			['swiftcWasm', options.swiftcWasm],
			['swiftpmWasm', options.swiftpmWasm],
			['sdkArchive', options.sdkArchive]
		]
			.filter(([, value]) => typeof value === 'string' && value.trim())
			.map(([name, value]) => [name, path.resolve(value)])
	);
	return {
		format: 'wasm-idle-swift-workflow-preflight-v1',
		status: errors.length === 0 ? 'passed' : 'failed',
		checkedAt: new Date().toISOString(),
		bootstrapSource: !!options.bootstrapSource,
		sourceRoot: path.resolve(options.sourceRoot ?? DEFAULT_SOURCE_ROOT),
		sourceBootstrapReceipt:
			typeof options.sourceBootstrapReceipt === 'string' && options.sourceBootstrapReceipt.trim()
				? path.resolve(options.sourceBootstrapReceipt)
				: null,
		buildDir: path.resolve(options.buildDir ?? DEFAULT_BUILD_DIR),
		minFreeGiB: options.minFreeGiB ?? DEFAULT_MIN_SWIFT_BUILD_FREE_GIB,
		swiftCloneDepth: options.swiftCloneDepth ?? null,
		swiftCloneFilter: options.swiftCloneFilter ?? null,
		hasBrowserBuildCommand:
			typeof options.browserBuildCommand === 'string' &&
			options.browserBuildCommand.trim().length > 0,
		explicitOutputPaths,
		swiftVersion: options.swiftVersion ?? null,
		wasmSdkId: options.wasmSdkId ?? null,
		publishedUrl: options.publishedUrl ?? null,
		disk,
		errors: [...errors]
	};
}

export async function writeSwiftWorkflowPreflightReceipt(receiptPath, receipt) {
	if (typeof receiptPath !== 'string' || !receiptPath.trim()) return null;
	const normalizedReceiptPath = path.resolve(receiptPath);
	await mkdir(path.dirname(normalizedReceiptPath), { recursive: true });
	await writeFile(normalizedReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
	return normalizedReceiptPath;
}

function usage() {
	return [
		'Usage: pnpm --dir runtime/swift run workflow:preflight -- --bootstrap-source <true|false> --source-root <dir> --build-dir <dir> --browser-build-command <command> --swift-version <version> --wasm-sdk-id <sdk_id>',
		'',
		'Checks manual wasm-swift runtime export workflow inputs before launching the expensive build steps.',
		'browser-build-command is required so exported artifacts include browserCompilerBuild.command provenance.',
		'source-bootstrap-receipt is required when bootstrap-source is false so strict source bootstrap provenance can pass.',
		'Explicit runner-worker, swiftc.wasm, swiftpm.wasm, and sdk.tar.gz paths are signature-checked when provided.',
		'Use --receipt <file> to write a JSON preflight receipt even when the check fails.',
		`--min-free-gib defaults to ${DEFAULT_MIN_SWIFT_BUILD_FREE_GIB} GiB and is checked against --build-dir.`
	].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		const options = parseSwiftWorkflowPreflightArgs(process.argv.slice(2));
		if (options.help) {
			console.log(usage());
		} else {
			const result = await checkSwiftWorkflowPreflight(options);
			await writeSwiftWorkflowPreflightReceipt(options.receiptPath, result.receipt);
			if (!result.ok) {
				throw new Error(`Swift workflow preflight failed:\n${result.errors.join('\n')}`);
			}
			console.log(
				`Swift workflow preflight passed for ${result.sourceRoot} with build dir ${result.buildDir}`
			);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
