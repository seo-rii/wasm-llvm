#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateSwiftRuntimeBundleInBrowser } from './runtime-contract-runner.mjs';
import {
	BUILD_PLAN_SNAPSHOT_FILE,
	BROWSER_BUILD_LOG_SNAPSHOT_FILE,
	SOURCE_BOOTSTRAP_RECEIPT_SNAPSHOT_FILE,
	swiftBaselineReceiptSnapshotFile,
	validateSwiftRuntimeBuildInfo,
	validateSwiftRuntimeSdkChecksum
} from './runtime-build-info.mjs';
import {
	validateSwiftRunnerWorkerSource,
	validateSwiftRuntimeManifestFiles
} from './runtime-manifest.mjs';
import { validateSwiftBrowserBuildPlan } from './verify-build-outputs.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const RUNTIME_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const REPO_ROOT = path.resolve(RUNTIME_ROOT, '..', '..');
const COMPRESSED_RUNTIME_ASSET_MANIFEST = 'compressed-runtime-assets.v1.json';
export const SWIFT_SYNC_RECEIPT_FILE = 'sync-receipt.v1.json';
export const SWIFT_SYNC_RECEIPT_FORMAT = 'wasm-swift-sync-receipt-v1';
const DEFAULT_BUNDLE_DIR = path.resolve(REPO_ROOT, 'static', 'wasm-swift');
const DEFAULT_CORE_LANGUAGES_PATH = path.resolve(
	REPO_ROOT,
	'packages',
	'core',
	'src',
	'languages.ts'
);
const DEFAULT_PLAYGROUND_INDEX_PATH = path.resolve(
	REPO_ROOT,
	'src',
	'lib',
	'playground',
	'index.ts'
);
const DEFAULT_SWIFT_VERSION_MODULE_PATH = path.resolve(
	REPO_ROOT,
	'src',
	'lib',
	'playground',
	'wasmSwiftVersion.ts'
);
const DEFAULT_PAGE_LANGUAGE_REGISTRY_PATH = path.resolve(
	REPO_ROOT,
	'src',
	'routes',
	'language-registry.ts'
);
const DEFAULT_SUPPORT_MATRIX_PATH = path.resolve(REPO_ROOT, 'scripts', 'support-matrix.mjs');

async function readText(filePath) {
	return readFile(filePath, 'utf8').catch(() => '');
}

async function isDirectory(dir) {
	const stats = await stat(dir).catch(() => null);
	return !!stats?.isDirectory();
}

export function sourceRegistersSwift(playgroundIndexSource) {
	const swiftRoute = playgroundIndexSource.match(
		/\{\s*aliases\s*:\s*\[[^\]]*['"]SWIFT['"][\s\S]*?load\s*:\s*async\s*\(\)\s*=>\s*\{[\s\S]*?import\s*\(\s*['"][^'"]*\/swift['"]\s*\)[\s\S]*?new\s+Swift\s*\(/u
	)?.[0];
	return (
		/supportedLanguages\s*=\s*\[[\s\S]*['"]SWIFT['"]/u.test(playgroundIndexSource) &&
		!!swiftRoute
	);
}

export function coreRegistersSwift(coreLanguagesSource) {
	const languageType = coreLanguagesSource.match(
		/(?:export\s+)?type\s+WasmIdleLanguageId\s*=\s*(?<value>[\s\S]*?);/u
	)?.groups?.value;
	return (
		typeof languageType === 'string' &&
		/['"]SWIFT['"]/u.test(languageType) &&
		/supportedLanguageIds\s*=\s*\[[^\]]*['"]SWIFT['"]/u.test(coreLanguagesSource) &&
		/DEFAULT_DEFERRED_PROGRESS_LANGUAGES\s*=\s*new\s+Set(?:<[^>]+>)?\s*\(\s*\[[^\]]*['"]SWIFT['"]/u.test(
			coreLanguagesSource
		)
	);
}

export function pageRegistryRegistersSwift(pageLanguageRegistrySource) {
	const languageType = pageLanguageRegistrySource.match(
		/(?:export\s+)?type\s+PlaygroundLanguage\s*=\s*(?<value>[\s\S]*?);/u
	)?.groups?.value;
	return (
		typeof languageType === 'string' &&
		/['"]SWIFT['"]/u.test(languageType) &&
		/playgroundLanguages\s*:\s*PlaygroundLanguage\[\]\s*=\s*\[[\s\S]*['"]SWIFT['"]/u.test(
			pageLanguageRegistrySource
		) &&
		/languageLabels\s*:\s*Record<PlaygroundLanguage,\s*string>\s*=\s*\{[\s\S]*SWIFT\s*:\s*['"]Swift['"]/u.test(
			pageLanguageRegistrySource
		) &&
		/editorLanguages\s*:\s*Record<PlaygroundLanguage,\s*string>\s*=\s*\{[\s\S]*SWIFT\s*:\s*['"]swift['"]/u.test(
			pageLanguageRegistrySource
		) &&
		/argsHelpLanguages\s*=\s*new\s+Set<PlaygroundLanguage>\s*\(\s*\[[\s\S]*['"]SWIFT['"]/u.test(
			pageLanguageRegistrySource
		) &&
		/compilerDiagnosticLanguages\s*=\s*new\s+Set<PlaygroundLanguage>\s*\(\s*\[[\s\S]*['"]SWIFT['"]/u.test(
			pageLanguageRegistrySource
		) &&
		/diagnosticMarkerLanguages\s*=\s*new\s+Set\s*\(\s*\[[\s\S]*['"]swift['"]/u.test(
			pageLanguageRegistrySource
		) &&
		/monacoLanguageContributionLoaders\s*:\s*Record<string,\s*MonacoLanguageContributionLoader>\s*=\s*\{[\s\S]*swift\s*:\s*\(\)\s*=>\s*import\s*\(\s*['"]monaco-editor\/esm\/vs\/basic-languages\/swift\/swift\.contribution\.js['"]\s*\)/u.test(
			pageLanguageRegistrySource
		)
	);
}

export function supportMatrixRegistersSwift(supportMatrixSource) {
	const swiftSupportRow = supportMatrixSource.match(
		/\{\s*language\s*:\s*['"]Swift['"][\s\S]*?ids\s*:\s*\[[^\]]*['"]SWIFT['"][\s\S]*?\}/u
	)?.[0];
	return (
		!!swiftSupportRow &&
		/stdin\s*:\s*['"]Yes['"]/u.test(swiftSupportRow) &&
		/browserTest\s*:\s*\{/u.test(swiftSupportRow) &&
		!/blockedCandidateRows\s*=\s*\[[\s\S]*candidateIds\s*:\s*\[[\s\S]*['"]SWIFT['"]/u.test(
			supportMatrixSource
		)
	);
}

export function swiftAssetVersionFromSource(versionModuleSource) {
	const match = versionModuleSource.match(
		/export\s+const\s+WASM_SWIFT_ASSET_VERSION\s*=\s*['"]([^'"]+)['"]/u
	);
	return match?.[1] || '';
}

async function readRuntimeBuildInfo(bundleDir) {
	const buildInfoPath = path.join(bundleDir, 'runtime-build.json');
	try {
		return JSON.parse(await readFile(buildInfoPath, 'utf8'));
	} catch (error) {
		throw new Error(`Swift runtime build metadata could not be read from ${buildInfoPath}: ${error.message}`);
	}
}

async function validateSyncReceipt({ bundleDir, manifest, buildInfo }) {
	const receiptPath = path.join(bundleDir, SWIFT_SYNC_RECEIPT_FILE);
	const errors = [];
	let receipt;
	try {
		receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
	} catch (error) {
		return {
			receipt: null,
			errors: [
				`Swift sync receipt could not be read from ${receiptPath}: ${error.message}`
			]
		};
	}
	if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
		return {
			receipt: null,
			errors: ['Swift sync receipt must contain a JSON object']
		};
	}
	if (receipt.format !== SWIFT_SYNC_RECEIPT_FORMAT) {
		errors.push(`Swift sync receipt format must be ${SWIFT_SYNC_RECEIPT_FORMAT}`);
	}
	if (receipt.fingerprint !== manifest?.fingerprint) {
		errors.push(
			`Swift sync receipt fingerprint ${receipt.fingerprint} does not match manifest ${manifest?.fingerprint}`
		);
	}
	if (receipt.swiftVersion !== manifest?.swiftVersion) {
		errors.push(
			`Swift sync receipt swiftVersion ${receipt.swiftVersion} does not match manifest ${manifest?.swiftVersion}`
		);
	}
	if (receipt.wasmSdkId !== manifest?.wasmSdkId) {
		errors.push(
			`Swift sync receipt wasmSdkId ${receipt.wasmSdkId} does not match manifest ${manifest?.wasmSdkId}`
		);
	}
	const runtimeBuildSource = await readFile(path.join(bundleDir, 'runtime-build.json'), 'utf8');
	const runtimeBuildSha256 = createHash('sha256').update(runtimeBuildSource).digest('hex');
	if (receipt.runtimeBuildSha256 !== runtimeBuildSha256) {
		errors.push(
			`Swift sync receipt runtimeBuildSha256 ${receipt.runtimeBuildSha256} does not match runtime-build.json ${runtimeBuildSha256}`
		);
	}
	if (JSON.stringify(receipt.runtimeContract) !== JSON.stringify(buildInfo?.runtimeContract)) {
		errors.push('Swift sync receipt runtimeContract does not match runtime-build.json');
	}
	for (const field of ['sourceDir', 'targetDir', 'versionModulePath']) {
		if (typeof receipt[field] !== 'string' || receipt[field].trim().length === 0) {
			errors.push(`Swift sync receipt ${field} must be a non-empty string`);
		}
	}
	return { receipt, errors };
}

export function parseBuildPlanProvenance(source) {
	const match = source.match(
		/(?:^|;\s*)build-plan=(?<planPath>[^;]+);\s*build-plan-sha256=(?<sha256>[a-f0-9]{64})(?:;|$)/u
	);
	return match?.groups ?? null;
}

export async function validateBuildPlanProvenance(
	source,
	{
		bundleDir,
		requireBrowserBuildCommand = false,
		requireBrowserBuildExecution = false,
		requireSourceBootstrapProvenance = false
	} = {}
) {
	const match = parseBuildPlanProvenance(source);
	if (!match) {
		return {
			planPath: null,
			plan: null,
			errors: ['runtime-build.json build plan provenance is required']
		};
	}
	const planPath = match.planPath.trim();
	if (!path.isAbsolute(planPath)) {
		return {
			planPath,
			plan: null,
			errors: ['runtime-build.json build plan provenance path must be absolute']
		};
	}
	const snapshotPath = bundleDir ? path.join(bundleDir, BUILD_PLAN_SNAPSHOT_FILE) : null;
	let planBytes = await readFile(planPath).catch(() => null);
	let sourcePath = planPath;
	let usedSnapshot = false;
	if (!planBytes && snapshotPath) {
		planBytes = await readFile(snapshotPath).catch(() => null);
		sourcePath = snapshotPath;
		usedSnapshot = !!planBytes;
	}
	if (!planBytes) {
		return {
			planPath,
			plan: null,
			errors: [
				snapshotPath
					? `runtime-build.json build plan provenance file was not found: ${planPath}; fallback snapshot was not found at ${snapshotPath}`
					: `runtime-build.json build plan provenance file was not found: ${planPath}`
			]
		};
	}
	const actualDigest = createHash('sha256').update(planBytes).digest('hex');
	if (actualDigest !== match.sha256) {
		return {
			planPath,
			plan: null,
			errors: [
				`runtime-build.json build plan sha256 mismatch for ${sourcePath}: expected ${match.sha256}, got ${actualDigest}`
			]
		};
	}
	let plan;
	try {
		plan = JSON.parse(planBytes.toString('utf8'));
	} catch (error) {
		return {
			planPath,
			plan: null,
			errors: [
				`runtime-build.json build plan could not be parsed at ${sourcePath}: ${error.message}`
			]
		};
	}
	const planErrors = validateSwiftBrowserBuildPlan(plan, {
		requireBrowserCompilerContracts: true,
		requireBrowserBuildCommand,
		requireBrowserBuildExecution,
		requireSourceBootstrapProvenance
	});
	return {
		planPath,
		plan,
		usedSnapshot,
		sourcePath,
		errors: planErrors.map((error) => `runtime-build.json build plan ${error}`)
	};
}

function parseReceiptIsoTimestamp(value) {
	if (typeof value !== 'string') return null;
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) return null;
	return timestamp;
}

export function expectedBaselineCommandByPreset(plan) {
	const presets = plan?.upstreamWasmBaseline?.presets;
	const commands = plan?.upstreamWasmBaseline?.commands;
	if (!Array.isArray(presets) || !Array.isArray(commands)) return new Map();
	return new Map(
		presets
			.map((preset, index) => [preset, commands[index]])
			.filter(([preset, command]) => typeof preset === 'string' && Array.isArray(command))
	);
}

export async function validateBaselineReceiptProvenance(
	source,
	{ expectedBuildPlanPath, expectedCommands = new Map(), bundleDir } = {}
) {
	const matches = [
		...source.matchAll(
			/(?:^|;\s*)upstream-baseline-(?<preset>[A-Za-z0-9._+-]+)-receipt=(?<receiptPath>[^;]+);\s*upstream-baseline-\k<preset>-sha256=(?<sha256>[a-f0-9]{64})(?:;|$)/gu
		)
	];
	if (matches.length === 0) {
		return {
			errors: ['runtime-build.json upstream baseline receipt provenance is required'],
			receipts: []
		};
	}
	const errors = [];
	const receipts = [];
	for (const match of matches) {
		const { preset, receiptPath, sha256 } = match.groups;
		const normalizedReceiptPath = receiptPath.trim();
		if (!path.isAbsolute(normalizedReceiptPath)) {
			errors.push(
				`runtime-build.json upstream baseline receipt path must be absolute for ${preset}`
			);
			continue;
		}
		const snapshotPath = bundleDir
			? path.join(bundleDir, swiftBaselineReceiptSnapshotFile(preset))
			: null;
		let receiptBytes = await readFile(normalizedReceiptPath).catch(() => null);
		let sourcePath = normalizedReceiptPath;
		if (!receiptBytes && snapshotPath) {
			receiptBytes = await readFile(snapshotPath).catch(() => null);
			sourcePath = snapshotPath;
		}
		if (!receiptBytes) {
			errors.push(
				snapshotPath
					? `runtime-build.json upstream baseline receipt file was not found: ${normalizedReceiptPath}; fallback snapshot was not found at ${snapshotPath}`
					: `runtime-build.json upstream baseline receipt file was not found: ${normalizedReceiptPath}`
			);
			continue;
		}
		const actualDigest = createHash('sha256').update(receiptBytes).digest('hex');
		if (actualDigest !== sha256) {
			errors.push(
				`runtime-build.json upstream baseline receipt sha256 mismatch for ${sourcePath}: expected ${sha256}, got ${actualDigest}`
			);
			continue;
		}
		receipts.push({
			preset,
			receiptPath: normalizedReceiptPath,
			sourcePath,
			usedSnapshot: sourcePath !== normalizedReceiptPath
		});
		let receipt;
		try {
			receipt = JSON.parse(receiptBytes.toString('utf8'));
		} catch (error) {
			errors.push(
				`runtime-build.json upstream baseline receipt could not be parsed at ${sourcePath}: ${error.message}`
			);
			continue;
		}
		if (receipt?.format !== 'wasm-idle-swift-upstream-baseline-build-v1') {
			errors.push(
				`runtime-build.json upstream baseline receipt format is invalid for ${normalizedReceiptPath}`
			);
		}
		if (receipt?.preset !== preset) {
			errors.push(
				`runtime-build.json upstream baseline receipt preset ${receipt?.preset ?? 'missing'} does not match ${preset}`
			);
		}
		if (typeof receipt?.planPath !== 'string' || !path.isAbsolute(receipt.planPath)) {
			errors.push(
				`runtime-build.json upstream baseline receipt planPath must be absolute for ${preset}`
			);
		} else if (expectedBuildPlanPath && receipt.planPath !== expectedBuildPlanPath) {
			errors.push(
				`runtime-build.json upstream baseline receipt planPath ${receipt.planPath} does not match build plan provenance ${expectedBuildPlanPath} for ${preset}`
			);
		}
		if (
			!Array.isArray(receipt?.command) ||
			receipt.command.length === 0 ||
			receipt.command.some((part) => typeof part !== 'string' || part.length === 0)
		) {
			errors.push(
				`runtime-build.json upstream baseline receipt command must be a non-empty string array for ${preset}`
			);
		} else {
			const expectedCommand = expectedCommands.get(preset);
			if (
				expectedCommand &&
				JSON.stringify(receipt.command) !== JSON.stringify(expectedCommand)
			) {
				errors.push(
					`runtime-build.json upstream baseline receipt command does not match build plan command for ${preset}`
				);
			}
		}
		if (typeof receipt?.cwd !== 'string' || !path.isAbsolute(receipt.cwd)) {
			errors.push(
				`runtime-build.json upstream baseline receipt cwd must be absolute for ${preset}`
			);
		}
		if (receipt?.status !== 'passed') {
			errors.push(
				`runtime-build.json upstream baseline receipt status must be passed for ${preset}`
			);
		}
		if (receipt?.status === 'passed' && receipt?.exitCode !== 0) {
			errors.push(
				`runtime-build.json upstream baseline receipt exitCode must be 0 for ${preset}`
			);
		}
		if (receipt?.status === 'passed') {
			const startedAt = parseReceiptIsoTimestamp(receipt?.startedAt);
			const finishedAt = parseReceiptIsoTimestamp(receipt?.finishedAt);
			if (startedAt === null) {
				errors.push(
					`runtime-build.json upstream baseline receipt startedAt must be an ISO timestamp for ${preset}`
				);
			}
			if (finishedAt === null) {
				errors.push(
					`runtime-build.json upstream baseline receipt finishedAt must be an ISO timestamp for ${preset}`
				);
			}
			if (startedAt !== null && finishedAt !== null && finishedAt < startedAt) {
				errors.push(
					`runtime-build.json upstream baseline receipt finishedAt must not be before startedAt for ${preset}`
				);
			}
		}
	}
	return { errors, receipts };
}

export function parseSourceBootstrapReceiptProvenance(source) {
	const match = source.match(
		/(?:^|;\s*)source-bootstrap-receipt=(?<receiptPath>[^;]+);\s*source-bootstrap-sha256=(?<sha256>[a-f0-9]{64})(?:;|$)/u
	);
	return match?.groups ?? null;
}

export async function validateSourceBootstrapReceiptProvenance(
	source,
	{ expectedSourceBootstrap, bundleDir } = {}
) {
	const match = parseSourceBootstrapReceiptProvenance(source);
	if (!match) {
		return {
			receipt: null,
			errors: ['runtime-build.json source bootstrap receipt provenance is required']
		};
	}
	const receiptPath = match.receiptPath.trim();
	if (!path.isAbsolute(receiptPath)) {
		return {
			receipt: null,
			errors: ['runtime-build.json source bootstrap receipt path must be absolute']
		};
	}
	const snapshotPath = bundleDir
		? path.join(bundleDir, SOURCE_BOOTSTRAP_RECEIPT_SNAPSHOT_FILE)
		: null;
	let receiptBytes = await readFile(receiptPath).catch(() => null);
	let sourcePath = receiptPath;
	if (!receiptBytes && snapshotPath) {
		receiptBytes = await readFile(snapshotPath).catch(() => null);
		sourcePath = snapshotPath;
	}
	if (!receiptBytes) {
		return {
			receipt: null,
			errors: [
				snapshotPath
					? `runtime-build.json source bootstrap receipt file was not found: ${receiptPath}; fallback snapshot was not found at ${snapshotPath}`
					: `runtime-build.json source bootstrap receipt file was not found: ${receiptPath}`
			]
		};
	}
	const actualDigest = createHash('sha256').update(receiptBytes).digest('hex');
	if (actualDigest !== match.sha256) {
		return {
			receipt: null,
			errors: [
				`runtime-build.json source bootstrap receipt sha256 mismatch for ${sourcePath}: expected ${match.sha256}, got ${actualDigest}`
			]
		};
	}
	let receipt;
	try {
		receipt = JSON.parse(receiptBytes.toString('utf8'));
	} catch (error) {
		return {
			receipt: null,
			errors: [
				`runtime-build.json source bootstrap receipt could not be parsed at ${sourcePath}: ${error.message}`
			]
		};
	}
	const errors = [];
	if (receipt?.format !== 'wasm-idle-swift-source-bootstrap-receipt-v1') {
		errors.push('runtime-build.json source bootstrap receipt format is invalid');
	}
	if (receipt?.status !== 'passed') {
		errors.push('runtime-build.json source bootstrap receipt status must be passed');
	}
	if (typeof receipt?.sourceRoot !== 'string' || !path.isAbsolute(receipt.sourceRoot)) {
		errors.push('runtime-build.json source bootstrap receipt sourceRoot must be absolute');
	}
	for (const field of ['swiftRepository', 'swiftRef', 'dependencyScheme']) {
		if (typeof receipt?.[field] !== 'string' || receipt[field].trim().length === 0) {
			errors.push(`runtime-build.json source bootstrap receipt ${field} is required`);
		}
	}
	for (const field of ['startedAt', 'finishedAt']) {
		const timestamp = parseReceiptIsoTimestamp(receipt?.[field]);
		if (timestamp === null) {
			errors.push(`runtime-build.json source bootstrap receipt ${field} must be an ISO timestamp`);
		}
	}
	const startedAt = parseReceiptIsoTimestamp(receipt?.startedAt);
	const finishedAt = parseReceiptIsoTimestamp(receipt?.finishedAt);
	if (startedAt !== null && finishedAt !== null && finishedAt < startedAt) {
		errors.push('runtime-build.json source bootstrap receipt finishedAt must not be before startedAt');
	}
	if (!receipt?.checkout || typeof receipt.checkout !== 'object' || Array.isArray(receipt.checkout)) {
		errors.push('runtime-build.json source bootstrap receipt checkout must be an object');
	} else if (receipt.checkout.ok !== true) {
		errors.push('runtime-build.json source bootstrap receipt checkout.ok must be true');
	}
	if (expectedSourceBootstrap && typeof expectedSourceBootstrap === 'object') {
		if (expectedSourceBootstrap.path !== receiptPath) {
			errors.push(
				`runtime-build.json source bootstrap receipt path ${receiptPath} does not match build plan sourceBootstrap.path ${expectedSourceBootstrap.path}`
			);
		}
		for (const field of ['sourceRoot', 'swiftRepository', 'swiftRef', 'dependencyScheme']) {
			if (expectedSourceBootstrap[field] !== receipt?.[field]) {
				errors.push(
					`runtime-build.json source bootstrap receipt ${field} does not match build plan sourceBootstrap.${field}`
				);
			}
		}
	}
	return {
		receipt: {
			receiptPath,
			sourcePath,
			usedSnapshot: sourcePath !== receiptPath
		},
		errors
	};
}

export function parseBrowserBuildLogProvenance(source) {
	if (typeof source !== 'string') return null;
	const match = source.match(
		/(?:^|;\s*)browser-build-log=(?<logPath>[^;]+);\s*browser-build-log-sha256=(?<sha256>[a-f0-9]{64})(?:;|$)/u
	);
	return match?.groups ?? null;
}

export async function validateBrowserBuildLogProvenance(source, { bundleDir } = {}) {
	const match = parseBrowserBuildLogProvenance(source);
	if (!match) {
		return {
			log: null,
			errors: ['runtime-build.json browser build log provenance is required']
		};
	}
	const logPath = match.logPath.trim();
	if (!path.isAbsolute(logPath)) {
		return {
			log: null,
			errors: ['runtime-build.json browser build log path must be absolute']
		};
	}
	const snapshotPath = bundleDir ? path.join(bundleDir, BROWSER_BUILD_LOG_SNAPSHOT_FILE) : null;
	let logBytes = await readFile(logPath).catch(() => null);
	let sourcePath = logPath;
	if (!logBytes && snapshotPath) {
		logBytes = await readFile(snapshotPath).catch(() => null);
		sourcePath = snapshotPath;
	}
	if (!logBytes) {
		return {
			log: null,
			errors: [
				snapshotPath
					? `runtime-build.json browser build log file was not found: ${logPath}; fallback snapshot was not found at ${snapshotPath}`
					: `runtime-build.json browser build log file was not found: ${logPath}`
			]
		};
	}
	const actualDigest = createHash('sha256').update(logBytes).digest('hex');
	if (actualDigest !== match.sha256) {
		return {
			log: null,
			errors: [
				`runtime-build.json browser build log sha256 mismatch for ${sourcePath}: expected ${match.sha256}, got ${actualDigest}`
			]
		};
	}
	return {
		log: {
			logPath,
			sourcePath,
			usedSnapshot: sourcePath !== logPath
		},
		errors: []
	};
}

async function validateCompressedRuntimeAssetManifest(bundleDir, manifest) {
	const manifestPath = path.join(path.dirname(bundleDir), COMPRESSED_RUNTIME_ASSET_MANIFEST);
	let compressedManifest;
	try {
		compressedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
	} catch (error) {
		return [
			`Swift compressed runtime asset manifest could not be read from ${manifestPath}: ${error.message}`
		];
	}
	const assets = Array.isArray(compressedManifest.assets) ? compressedManifest.assets : [];
	const sizes =
		compressedManifest.sizes && typeof compressedManifest.sizes === 'object'
			? compressedManifest.sizes
			: {};
	const errors = [];
	for (const wasmFile of ['swiftc.wasm', 'swiftpm.wasm']) {
		const assetPath = `${path.basename(bundleDir)}/${wasmFile}`;
		const manifestEntry = manifest?.files?.find((file) => file?.path === wasmFile);
		if (!assets.includes(assetPath)) {
			errors.push(`${assetPath} is missing from ${COMPRESSED_RUNTIME_ASSET_MANIFEST}`);
		}
		if (manifestEntry && sizes[assetPath] !== manifestEntry.bytes) {
			errors.push(
				`${assetPath} size in ${COMPRESSED_RUNTIME_ASSET_MANIFEST} must match runtime-manifest.v1.json bytes`
			);
		}
		try {
			await readFile(path.join(bundleDir, `${wasmFile}.gz`));
		} catch {
			errors.push(`${wasmFile}.gz is required when compressed Swift readiness is enabled`);
		}
	}
	return errors;
}

export async function checkSwiftReadiness({
	bundleDir = DEFAULT_BUNDLE_DIR,
	coreLanguagesPath = DEFAULT_CORE_LANGUAGES_PATH,
	playgroundIndexPath = DEFAULT_PLAYGROUND_INDEX_PATH,
	pageLanguageRegistryPath = DEFAULT_PAGE_LANGUAGE_REGISTRY_PATH,
	supportMatrixPath = DEFAULT_SUPPORT_MATRIX_PATH,
	swiftVersionModulePath = DEFAULT_SWIFT_VERSION_MODULE_PATH,
	requireRegistered = false,
	requireBuildPlanProvenance = false,
	requireSourceBootstrapProvenance = false,
	requireBrowserBuildCommandProvenance = false,
	requireBrowserBuildExecutionProvenance = false,
	requireBrowserBuildLogProvenance = false,
	requireBaselineProvenance = false,
	requireCompressedManifest = false,
	runBrowserContract = false,
	timeoutMs
} = {}) {
	const errors = [];
	const warnings = [];
	const normalizedBundleDir = path.resolve(bundleDir);
	const coreLanguagesSource = await readText(coreLanguagesPath);
	const playgroundIndexSource = await readText(playgroundIndexPath);
	const pageLanguageRegistrySource = await readText(pageLanguageRegistryPath);
	const supportMatrixSource = await readText(supportMatrixPath);
	const versionModuleSource = await readText(swiftVersionModulePath);
	const coreRegistered = coreRegistersSwift(coreLanguagesSource);
	const playgroundRegistered = sourceRegistersSwift(playgroundIndexSource);
	const pageRegistered = pageRegistryRegistersSwift(pageLanguageRegistrySource);
	const supportMatrixRegistered = supportMatrixRegistersSwift(supportMatrixSource);
	const registered =
		coreRegistered && playgroundRegistered && pageRegistered && supportMatrixRegistered;
	const assetVersion = swiftAssetVersionFromSource(versionModuleSource);
	const bundleExists = await isDirectory(normalizedBundleDir);

	if (requireRegistered && !coreRegistered) {
		errors.push(
			'SWIFT is not fully registered in packages/core/src/languages.ts WasmIdleLanguageId, supportedLanguageIds, and DEFAULT_DEFERRED_PROGRESS_LANGUAGES'
		);
	}
	if (requireRegistered && !playgroundRegistered) {
		errors.push('SWIFT is not registered in src/lib/playground/index.ts supportedLanguages');
	}
	if (requireRegistered && !pageRegistered) {
		errors.push(
			'SWIFT is not fully registered in src/routes/language-registry.ts PlaygroundLanguage, playgroundLanguages, languageLabels, editorLanguages, argsHelpLanguages, compilerDiagnosticLanguages, diagnosticMarkerLanguages, and monacoLanguageContributionLoaders'
		);
	}
	if (requireRegistered && !supportMatrixRegistered) {
		errors.push(
			'SWIFT is not fully registered as a stdin-capable supported language with browser test metadata in scripts/support-matrix.mjs'
		);
	}
	if (registered && !requireRegistered) {
		warnings.push('SWIFT is already registered; readiness must stay green before shipping.');
	}
	if (!assetVersion) {
		errors.push('WASM_SWIFT_ASSET_VERSION is missing');
	} else if (assetVersion === 'manual') {
		errors.push(
			'WASM_SWIFT_ASSET_VERSION is still manual; run sync:wasm-swift with a real bundle'
		);
	}
	if (!bundleExists) {
		errors.push(`Swift browser runtime bundle directory was not found: ${normalizedBundleDir}`);
		return {
			ready: false,
			registered,
			coreRegistered,
			playgroundRegistered,
			pageRegistered,
			supportMatrixRegistered,
			assetVersion,
			bundleDir: normalizedBundleDir,
			manifestValidated: false,
			compressedManifestValidated: false,
			browserContractValidated: false,
			errors,
			warnings
		};
	}

	const manifestPath = path.join(normalizedBundleDir, 'runtime-manifest.v1.json');
	let manifest;
	try {
		manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
	} catch (error) {
		errors.push(
			`Swift runtime manifest could not be read from ${manifestPath}: ${error.message}`
		);
	}

	let manifestValidated = false;
	let buildInfo;
	const provenance = {
		buildPlan: null,
		sourceBootstrapReceipt: null,
		browserBuildLog: null,
		baselineReceipts: [],
		syncReceipt: null
	};
	if (manifest) {
		const manifestErrors = await validateSwiftRuntimeManifestFiles(
			normalizedBundleDir,
			manifest
		);
		if (manifestErrors.length > 0) {
			errors.push(...manifestErrors);
		} else {
			manifestValidated = true;
			if (assetVersion && assetVersion !== manifest.fingerprint) {
				errors.push(
					`WASM_SWIFT_ASSET_VERSION ${assetVersion} does not match manifest fingerprint ${manifest.fingerprint}`
				);
			}
		}
	}

	let compressedManifestValidated = false;
	if (requireCompressedManifest && manifestValidated) {
		const compressedManifestErrors = await validateCompressedRuntimeAssetManifest(
			normalizedBundleDir,
			manifest
		);
		if (compressedManifestErrors.length > 0) {
			errors.push(...compressedManifestErrors);
		} else {
			compressedManifestValidated = true;
		}
	}

	const runnerWorkerPath = path.join(normalizedBundleDir, 'runner-worker.js');
	try {
		const runnerErrors = validateSwiftRunnerWorkerSource(
			await readFile(runnerWorkerPath, 'utf8')
		);
		if (runnerErrors.length > 0) {
			errors.push(
				`Swift runner-worker.js does not match the playground contract:\n${runnerErrors.join('\n')}`
			);
		}
	} catch (error) {
		errors.push(
			`Swift runner-worker.js could not be read from ${runnerWorkerPath}: ${error.message}`
		);
	}

	try {
		buildInfo = await readRuntimeBuildInfo(normalizedBundleDir);
		const buildInfoErrors = validateSwiftRuntimeBuildInfo(buildInfo);
		if (buildInfoErrors.length > 0) {
			errors.push(...buildInfoErrors.map((error) => `runtime-build.json ${error}`));
		}
		if (typeof buildInfo.source !== 'string' || buildInfo.source.trim().length === 0) {
			errors.push('runtime-build.json source provenance is required');
		} else {
			const buildPlanProvenance = parseBuildPlanProvenance(buildInfo.source);
			const expectedBuildPlanPath = buildPlanProvenance?.planPath?.trim();
			let validatedBuildPlan = null;
			if (requireBuildPlanProvenance) {
				const result = await validateBuildPlanProvenance(buildInfo.source, {
					bundleDir: normalizedBundleDir,
					requireBrowserBuildCommand: requireBrowserBuildCommandProvenance,
					requireBrowserBuildExecution: requireBrowserBuildExecutionProvenance,
					requireSourceBootstrapProvenance
				});
				validatedBuildPlan = result.plan;
				provenance.buildPlan = result.planPath
					? {
							planPath: result.planPath,
							sourcePath: result.sourcePath ?? result.planPath,
							usedSnapshot: !!result.usedSnapshot
						}
					: null;
				errors.push(...result.errors);
			}
			if (requireSourceBootstrapProvenance) {
				const sourceBootstrapResult = await validateSourceBootstrapReceiptProvenance(
					buildInfo.source,
					{
						expectedSourceBootstrap: validatedBuildPlan?.sourceBootstrap,
						bundleDir: normalizedBundleDir
					}
				);
				provenance.sourceBootstrapReceipt = sourceBootstrapResult.receipt;
				errors.push(...sourceBootstrapResult.errors);
			}
			if (requireBaselineProvenance) {
				const baselineResult = await validateBaselineReceiptProvenance(buildInfo.source, {
					expectedBuildPlanPath: path.isAbsolute(expectedBuildPlanPath || '')
						? expectedBuildPlanPath
						: undefined,
					expectedCommands: expectedBaselineCommandByPreset(validatedBuildPlan),
					bundleDir: normalizedBundleDir
				});
				provenance.baselineReceipts = baselineResult.receipts;
				errors.push(...baselineResult.errors);
			}
			if (requireBrowserBuildLogProvenance) {
				const browserBuildLogResult = await validateBrowserBuildLogProvenance(
					buildInfo.source,
					{
						bundleDir: normalizedBundleDir
					}
				);
				provenance.browserBuildLog = browserBuildLogResult.log;
				errors.push(...browserBuildLogResult.errors);
			}
		}
		if (manifest) {
			if (buildInfo.swiftVersion !== manifest.swiftVersion) {
				errors.push(
					`runtime-build.json swiftVersion ${buildInfo.swiftVersion} does not match manifest ${manifest.swiftVersion}`
				);
			}
			if (buildInfo.wasmSdkId !== manifest.wasmSdkId) {
				errors.push(
					`runtime-build.json wasmSdkId ${buildInfo.wasmSdkId} does not match manifest ${manifest.wasmSdkId}`
				);
			}
		}
		errors.push(
			...(await validateSwiftRuntimeSdkChecksum(buildInfo, {
				bundleDir: normalizedBundleDir
			}))
		);
		if (manifest) {
			const syncReceiptResult = await validateSyncReceipt({
				bundleDir: normalizedBundleDir,
				manifest,
				buildInfo
			});
			provenance.syncReceipt = syncReceiptResult.receipt;
			errors.push(...syncReceiptResult.errors);
		}
	} catch (error) {
		errors.push(error.message);
	}

	let browserContractValidated = false;
	if (runBrowserContract && manifestValidated) {
		try {
			await validateSwiftRuntimeBundleInBrowser({
				bundleDir: normalizedBundleDir,
				timeoutMs
			});
			browserContractValidated = true;
		} catch (error) {
			errors.push(`Swift browser runtime contract failed: ${error.message}`);
		}
	}

	return {
		ready:
			errors.length === 0 &&
			manifestValidated &&
			(!requireCompressedManifest || compressedManifestValidated) &&
			(!runBrowserContract || browserContractValidated),
		registered,
		coreRegistered,
		playgroundRegistered,
		pageRegistered,
		supportMatrixRegistered,
		assetVersion,
		bundleDir: normalizedBundleDir,
		manifestValidated,
		compressedManifestValidated,
		browserContractValidated,
		provenance,
		errors,
		warnings
	};
}

function readOptionValue(argv, index, optionName) {
	const value = argv[index + 1];
	if (typeof value !== 'string' || !value || value.startsWith('--')) {
		throw new Error(`${optionName} requires a value`);
	}
	return value;
}

function assertTimeoutMs(timeoutMs) {
	if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
		throw new Error('timeoutMs must be a positive safe integer when provided');
	}
}

export function parseSwiftReadinessArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--') {
			continue;
		} else if (arg === '--require-registered') {
			options.requireRegistered = true;
		} else if (arg === '--require-build-plan-provenance') {
			options.requireBuildPlanProvenance = true;
		} else if (arg === '--require-source-bootstrap-provenance') {
			options.requireSourceBootstrapProvenance = true;
		} else if (arg === '--require-browser-build-command-provenance') {
			options.requireBrowserBuildCommandProvenance = true;
		} else if (arg === '--require-browser-build-execution-provenance') {
			options.requireBrowserBuildExecutionProvenance = true;
		} else if (arg === '--require-browser-build-log-provenance') {
			options.requireBrowserBuildLogProvenance = true;
		} else if (arg === '--require-upstream-baseline-provenance') {
			options.requireBaselineProvenance = true;
		} else if (arg === '--require-compressed-manifest') {
			options.requireCompressedManifest = true;
		} else if (arg === '--browser-contract') {
			options.runBrowserContract = true;
		} else if (arg === '--bundle-dir') {
			options.bundleDir = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--timeout-ms') {
			options.timeoutMs = Number(readOptionValue(argv, index, arg));
			assertTimeoutMs(options.timeoutMs);
			index += 1;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	assertTimeoutMs(options.timeoutMs);
	return options;
}

async function main(argv = process.argv.slice(2)) {
	const report = await checkSwiftReadiness(parseSwiftReadinessArgs(argv));
	for (const warning of report.warnings) console.warn(warning);
	if (report.ready) {
		console.log(`Swift runtime is ready: ${report.bundleDir}`);
		return;
	}
	for (const error of report.errors) console.error(error);
	process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
