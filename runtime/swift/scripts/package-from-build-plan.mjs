#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { packageSwiftRuntimeDist } from './package-runtime.mjs';
import {
	BUILD_PLAN_SNAPSHOT_FILE,
	BROWSER_BUILD_LOG_SNAPSHOT_FILE,
	SOURCE_BOOTSTRAP_RECEIPT_SNAPSHOT_FILE,
	WORKFLOW_PREFLIGHT_RECEIPT_SNAPSHOT_FILE,
	swiftBaselineReceiptSnapshotFile
} from './runtime-build-info.mjs';
import {
	OFFICIAL_WASM_SDK_CHECKSUM,
	OFFICIAL_WASM_SDK_URL
} from './probe-toolchain.mjs';
import { verifySwiftBrowserBuildOutputs } from './verify-build-outputs.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const RUNTIME_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const DEFAULT_PLAN_PATH = path.join(
	RUNTIME_ROOT,
	'browser-compiler-build',
	'wasm-idle-swift-browser-build-plan.json'
);
const DEFAULT_DIST_DIR = path.join(RUNTIME_ROOT, 'dist');

function readOptionValue(argv, index, optionName) {
	const value = argv[index + 1];
	if (typeof value !== 'string' || !value || value.startsWith('--')) {
		throw new Error(`${optionName} requires a value`);
	}
	return value;
}

function assertTimeoutMs(timeoutMs) {
	if (
		timeoutMs !== undefined &&
		(!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
	) {
		throw new Error('timeoutMs must be a positive safe integer when provided');
	}
}

async function formatBaselineReceiptProvenance(plan, { requireReceipt = false } = {}) {
	const receipts = plan?.upstreamWasmBaseline?.receipts;
	if (receipts === undefined) {
		if (requireReceipt) {
			throw new Error('upstreamWasmBaseline.receipts are required before packaging');
		}
		return { provenance: [], snapshots: [] };
	}
	if (!Array.isArray(receipts)) {
		throw new Error('upstreamWasmBaseline.receipts must be an array when provided');
	}
	if (requireReceipt && receipts.length === 0) {
		throw new Error('upstreamWasmBaseline.receipts must contain at least one passed receipt before packaging');
	}
	const provenance = [];
	const snapshots = [];
	for (const receipt of receipts) {
		if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
			throw new Error('upstreamWasmBaseline.receipts entries must be objects');
		}
		if (typeof receipt.preset !== 'string' || !/^[A-Za-z0-9._+-]+$/u.test(receipt.preset)) {
			throw new Error('upstreamWasmBaseline receipt preset must be a safe string');
		}
		if (typeof receipt.path !== 'string' || !path.isAbsolute(receipt.path)) {
			throw new Error('upstreamWasmBaseline receipt path must be absolute');
		}
		if (typeof receipt.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.sha256)) {
			throw new Error('upstreamWasmBaseline receipt sha256 must be a lowercase sha256 hex digest');
		}
		if (receipt.status !== 'passed') {
			throw new Error('upstreamWasmBaseline receipts must have status passed before packaging');
		}
		const receiptBytes = await readFile(receipt.path).catch((error) => {
			throw new Error(
				`upstreamWasmBaseline receipt could not be read at ${receipt.path}: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		});
		const actualDigest = createHash('sha256').update(receiptBytes).digest('hex');
		if (actualDigest !== receipt.sha256) {
			throw new Error(
				`upstreamWasmBaseline receipt sha256 mismatch for ${receipt.path}: expected ${receipt.sha256}, got ${actualDigest}`
			);
		}
		provenance.push(
			`upstream-baseline-${receipt.preset}-receipt=${receipt.path}; upstream-baseline-${receipt.preset}-sha256=${receipt.sha256}`
		);
		snapshots.push({
			fileName: swiftBaselineReceiptSnapshotFile(receipt.preset),
			bytes: receiptBytes
		});
	}
	return { provenance, snapshots };
}

async function formatSourceBootstrapReceiptProvenance(plan, { requireReceipt = false } = {}) {
	const receipt = plan?.sourceBootstrap;
	if (receipt === undefined || receipt === null) {
		if (requireReceipt) {
			throw new Error('sourceBootstrap receipt is required before packaging');
		}
		return { provenance: [], snapshots: [] };
	}
	if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
		throw new Error('sourceBootstrap must be an object when provided');
	}
	if (typeof receipt.path !== 'string' || !path.isAbsolute(receipt.path)) {
		throw new Error('sourceBootstrap.path must be an absolute path');
	}
	if (receipt.status !== 'passed') {
		throw new Error('sourceBootstrap.status must be passed before packaging');
	}
	const receiptBytes = await readFile(receipt.path).catch((error) => {
		throw new Error(
			`sourceBootstrap receipt could not be read at ${receipt.path}: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
	});
	const digest = createHash('sha256').update(receiptBytes).digest('hex');
	return {
		provenance: [
			`source-bootstrap-receipt=${receipt.path}; source-bootstrap-sha256=${digest}`
		],
		snapshots: [
			{
				fileName: SOURCE_BOOTSTRAP_RECEIPT_SNAPSHOT_FILE,
				bytes: receiptBytes
			}
		]
	};
}

async function formatBrowserBuildLogProvenance(plan, { requireLog = false } = {}) {
	const logPath = plan?.browserCompilerBuild?.execution?.logPath;
	if (logPath === undefined || logPath === null) {
		if (requireLog) {
			throw new Error('browserCompilerBuild.execution.logPath is required before packaging');
		}
		return { provenance: [], snapshots: [] };
	}
	if (typeof logPath !== 'string' || !path.isAbsolute(logPath)) {
		throw new Error('browserCompilerBuild.execution.logPath must be an absolute path');
	}
	const logBytes = await readFile(logPath).catch((error) => {
		throw new Error(
			`browserCompilerBuild.execution log could not be read at ${logPath}: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
	});
	const digest = createHash('sha256').update(logBytes).digest('hex');
	return {
		provenance: [`browser-build-log=${logPath}; browser-build-log-sha256=${digest}`],
		snapshots: [
			{
				fileName: BROWSER_BUILD_LOG_SNAPSHOT_FILE,
				bytes: logBytes
			}
		]
	};
}

async function formatWorkflowPreflightReceiptProvenance(receiptPath) {
	if (receiptPath === undefined || receiptPath === null || receiptPath === '') {
		return { provenance: [], snapshots: [] };
	}
	if (typeof receiptPath !== 'string' || !path.isAbsolute(receiptPath)) {
		throw new Error('workflow preflight receipt path must be absolute when provided');
	}
	const receiptBytes = await readFile(receiptPath).catch((error) => {
		throw new Error(
			`workflow preflight receipt could not be read at ${receiptPath}: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
	});
	let receipt;
	try {
		receipt = JSON.parse(receiptBytes.toString('utf8'));
	} catch (error) {
		throw new Error(
			`workflow preflight receipt could not be parsed at ${receiptPath}: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
	}
	if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
		throw new Error('workflow preflight receipt must contain a JSON object');
	}
	if (receipt.format !== 'wasm-idle-swift-workflow-preflight-v1') {
		throw new Error('workflow preflight receipt format is invalid');
	}
	if (receipt.status !== 'passed') {
		throw new Error('workflow preflight receipt status must be passed before packaging');
	}
	if (typeof receipt.sourceRoot !== 'string' || !path.isAbsolute(receipt.sourceRoot)) {
		throw new Error('workflow preflight receipt sourceRoot must be absolute');
	}
	if (typeof receipt.buildDir !== 'string' || !path.isAbsolute(receipt.buildDir)) {
		throw new Error('workflow preflight receipt buildDir must be absolute');
	}
	const digest = createHash('sha256').update(receiptBytes).digest('hex');
	return {
		provenance: [`workflow-preflight-receipt=${receiptPath}; workflow-preflight-sha256=${digest}`],
		snapshots: [
			{
				fileName: WORKFLOW_PREFLIGHT_RECEIPT_SNAPSHOT_FILE,
				bytes: receiptBytes
			}
		]
	};
}

function assertOfficialSdkFetchMatchesProvenance({
	officialWasmSdkProvenance,
	sdkUrl,
	sdkChecksum
}) {
	if (!officialWasmSdkProvenance) return;
	if (sdkUrl !== OFFICIAL_WASM_SDK_URL) {
		throw new Error(
			'--official-wasm-sdk-provenance requires the fetched --sdk-url to be the documented official Swift Wasm SDK URL'
		);
	}
	if (sdkChecksum !== OFFICIAL_WASM_SDK_CHECKSUM) {
		throw new Error(
			'--official-wasm-sdk-provenance requires the fetched --sdk-checksum to be the documented official Swift Wasm SDK checksum'
		);
	}
}

function assertSdkPlaceholderProvenance({
	allowOfficialSdkPlaceholder,
	officialWasmSdkProvenance,
	sdkUrl,
	sdkChecksum,
	wasmSdkUrl,
	wasmSdkChecksum
}) {
	if (!allowOfficialSdkPlaceholder || officialWasmSdkProvenance) return;
	if (!wasmSdkUrl || !wasmSdkChecksum) {
		throw new Error(
			'--allow-official-sdk-placeholder requires --official-wasm-sdk-provenance or matching --wasm-sdk-url and --wasm-sdk-checksum provenance'
		);
	}
	if (wasmSdkUrl !== sdkUrl) {
		throw new Error(
			'--allow-official-sdk-placeholder requires --wasm-sdk-url to match the fetched --sdk-url'
		);
	}
	if (wasmSdkChecksum !== sdkChecksum) {
		throw new Error(
			'--allow-official-sdk-placeholder requires --wasm-sdk-checksum to match the fetched --sdk-checksum'
		);
	}
}

export function parsePackageFromBuildPlanArgs(argv) {
	const options = {
		planPath: DEFAULT_PLAN_PATH,
		distDir: DEFAULT_DIST_DIR,
		allowOfficialSdkPlaceholder: false,
		sdkUrl: OFFICIAL_WASM_SDK_URL,
		sdkChecksum: OFFICIAL_WASM_SDK_CHECKSUM,
		runBrowserContract: false,
		officialWasmSdkProvenance: false,
		requireUpstreamBaselineReceipt: false,
		requireBrowserCompilerContracts: false,
		requireBrowserBuildCommand: false,
		requireBrowserBuildExecution: false,
		requireBrowserBuildLog: false,
		requireSourceBootstrapProvenance: false
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--') {
			continue;
		} else if (arg === '--help') {
			return { help: true };
		} else if (arg === '--plan') {
			options.planPath = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--dist-dir') {
			options.distDir = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--swift-version') {
			options.swiftVersion = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--wasm-sdk-id') {
			options.wasmSdkId = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--source') {
			options.source = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--workflow-preflight-receipt') {
			options.workflowPreflightReceipt = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--notes') {
			options.notes = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--allow-official-sdk-placeholder') {
			options.allowOfficialSdkPlaceholder = true;
		} else if (arg === '--sdk-url') {
			options.sdkUrl = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--sdk-checksum') {
			options.sdkChecksum = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--wasm-sdk-url') {
			options.wasmSdkUrl = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--wasm-sdk-checksum') {
			options.wasmSdkChecksum = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--official-wasm-sdk-provenance') {
			options.officialWasmSdkProvenance = true;
		} else if (arg === '--require-upstream-baseline-receipt') {
			options.requireUpstreamBaselineReceipt = true;
		} else if (arg === '--require-browser-compiler-contracts') {
			options.requireBrowserCompilerContracts = true;
		} else if (arg === '--require-browser-build-command') {
			options.requireBrowserBuildCommand = true;
		} else if (arg === '--require-browser-build-execution') {
			options.requireBrowserBuildExecution = true;
		} else if (arg === '--require-browser-build-log') {
			options.requireBrowserBuildLog = true;
		} else if (arg === '--require-source-bootstrap-provenance') {
			options.requireSourceBootstrapProvenance = true;
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

export async function packageSwiftRuntimeFromBuildPlan({
	planPath = DEFAULT_PLAN_PATH,
	distDir = DEFAULT_DIST_DIR,
	swiftVersion,
	wasmSdkId,
	source,
	workflowPreflightReceipt,
	notes,
	allowOfficialSdkPlaceholder = false,
	sdkUrl = OFFICIAL_WASM_SDK_URL,
	sdkChecksum = OFFICIAL_WASM_SDK_CHECKSUM,
	wasmSdkUrl,
	wasmSdkChecksum,
	officialWasmSdkProvenance = false,
	requireUpstreamBaselineReceipt = false,
	requireBrowserCompilerContracts = false,
	requireBrowserBuildCommand = false,
	requireBrowserBuildExecution = false,
	requireBrowserBuildLog = false,
	requireSourceBootstrapProvenance = false,
	runBrowserContract = false,
	timeoutMs,
	fetchImpl = globalThis.fetch
} = {}) {
	assertTimeoutMs(timeoutMs);
	assertOfficialSdkFetchMatchesProvenance({
		officialWasmSdkProvenance,
		sdkUrl,
		sdkChecksum
	});
	assertSdkPlaceholderProvenance({
		allowOfficialSdkPlaceholder,
		officialWasmSdkProvenance,
		sdkUrl,
		sdkChecksum,
		wasmSdkUrl,
		wasmSdkChecksum
	});
	const normalizedPlanPath = path.resolve(planPath);
	const planBytes = await readFile(normalizedPlanPath);
	const plan = JSON.parse(planBytes.toString('utf8'));
	const planDigest = createHash('sha256').update(planBytes).digest('hex');
	const baseline = await formatBaselineReceiptProvenance(plan, {
		requireReceipt: requireUpstreamBaselineReceipt
	});
	const sourceBootstrap = await formatSourceBootstrapReceiptProvenance(plan, {
		requireReceipt: requireSourceBootstrapProvenance
	});
	const browserBuildLog = await formatBrowserBuildLogProvenance(plan, {
		requireLog: requireBrowserBuildLog
	});
	const workflowPreflight = await formatWorkflowPreflightReceiptProvenance(
		workflowPreflightReceipt
	);
	const verified = await verifySwiftBrowserBuildOutputs({
		planPath: normalizedPlanPath,
		allowOfficialSdkPlaceholder,
		prepareRawRuntime: true,
		requireBrowserCompilerContracts,
		requireBrowserBuildCommand,
		requireBrowserBuildExecution,
		requireBrowserBuildLog,
		requireSourceBootstrapProvenance,
		sdkUrl,
		sdkChecksum,
		fetchImpl
	});
	const provenance = source
		? `${source}; build-plan=${normalizedPlanPath}; build-plan-sha256=${planDigest}`
		: `build-plan=${normalizedPlanPath}; build-plan-sha256=${planDigest}`;
	await writeFile(path.join(verified.rawRuntimeDir, BUILD_PLAN_SNAPSHOT_FILE), planBytes);
	for (const snapshot of sourceBootstrap.snapshots) {
		await writeFile(path.join(verified.rawRuntimeDir, snapshot.fileName), snapshot.bytes);
	}
	for (const snapshot of baseline.snapshots) {
		await writeFile(path.join(verified.rawRuntimeDir, snapshot.fileName), snapshot.bytes);
	}
	for (const snapshot of browserBuildLog.snapshots) {
		await writeFile(path.join(verified.rawRuntimeDir, snapshot.fileName), snapshot.bytes);
	}
	for (const snapshot of workflowPreflight.snapshots) {
		await writeFile(path.join(verified.rawRuntimeDir, snapshot.fileName), snapshot.bytes);
	}
	return packageSwiftRuntimeDist({
		sourceDir: verified.rawRuntimeDir,
		distDir,
		swiftVersion,
		wasmSdkId,
		wasmSdkUrl,
		wasmSdkChecksum,
		source: [
			provenance,
			...sourceBootstrap.provenance,
			...baseline.provenance,
			...browserBuildLog.provenance,
			...workflowPreflight.provenance
		].join('; '),
		notes,
		officialWasmSdkProvenance,
		runBrowserContract,
		timeoutMs
	});
}

function usage() {
	return [
		'Usage: pnpm --dir runtime/swift run package:from-plan -- --plan <build-plan.json> --swift-version <version> --wasm-sdk-id <sdk_id> --source <provenance>',
		'',
		'Verifies browser compiler outputs recorded by build:browser-compiler, prepares raw-runtime,',
		'and packages runtime/swift/dist with build-plan provenance.',
		'Use --allow-official-sdk-placeholder when the plan uses the documented Swift.org SDK archive.',
		'Use --official-wasm-sdk-provenance to record the official SDK URL/checksum in runtime-build.json.',
		'Without --official-wasm-sdk-provenance, placeholder SDK fetches require matching --wasm-sdk-url and --wasm-sdk-checksum.',
		'Use --require-upstream-baseline-receipt to require a passed baseline receipt in the build plan.',
		'Use --require-browser-compiler-contracts to require build plan output contracts.',
		'Use --require-browser-build-command to require browserCompilerBuild.command provenance.',
		'Use --require-browser-build-execution to require a passed browserCompilerBuild.execution receipt.',
		'Use --require-browser-build-log to require the execution receipt logPath file.',
		'Use --require-source-bootstrap-provenance to require sourceBootstrap receipt provenance.',
		'Use --workflow-preflight-receipt <file> to preserve the workflow dispatch preflight receipt.',
		'Use --browser-contract to run the staged package through Chromium before replacing dist.'
	].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		const options = parsePackageFromBuildPlanArgs(process.argv.slice(2));
		if (options.help) {
			console.log(usage());
		} else {
			const result = await packageSwiftRuntimeFromBuildPlan(options);
			console.log(`Packaged wasm-swift runtime dist from build plan at ${result.distDir}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
