#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverSwiftBrowserBuildOutputs } from './discover-build-outputs.mjs';
import {
	DEFAULT_API_URL,
	discoverSwiftUpstreamAssets,
	writeSwiftUpstreamDiscoveryReceipt
} from './discover-upstream-assets.mjs';
import { probeSwiftToolchain, swiftWasmMetadata } from './probe-toolchain.mjs';
import { checkSwiftReadiness } from './readiness.mjs';
import { validateSwiftBrowserBuildPlan } from './verify-build-outputs.mjs';
import {
	DEFAULT_MIN_SWIFT_BUILD_FREE_GIB,
	formatGiB,
	inspectFreeDiskSpace
} from './disk-space.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const RUNTIME_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const REPO_ROOT = path.resolve(RUNTIME_ROOT, '..', '..');
const DEFAULT_BUILD_DIR = path.join(RUNTIME_ROOT, 'browser-compiler-build');
const DEFAULT_BUNDLE_DIR = path.join(REPO_ROOT, 'static', 'wasm-swift');
const DEFAULT_PLAN_PATH = path.join(DEFAULT_BUILD_DIR, 'wasm-idle-swift-browser-build-plan.json');

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

function assertHttpUrl(value, optionName) {
	if (typeof value !== 'string' || !/^https?:\/\//u.test(value)) {
		throw new Error(`${optionName} must be an HTTP(S) URL`);
	}
}

function assertSwiftDoctorOptionCombination({ skipUpstream, upstreamApiUrl, upstreamReceiptPath }) {
	if (skipUpstream && upstreamApiUrl !== DEFAULT_API_URL) {
		throw new Error('--upstream-api-url cannot be used with --skip-upstream');
	}
	if (skipUpstream && upstreamReceiptPath) {
		throw new Error('--upstream-receipt cannot be used with --skip-upstream');
	}
}

export function parseSwiftDoctorArgs(argv) {
	const options = {
		buildDir: DEFAULT_BUILD_DIR,
		bundleDir: DEFAULT_BUNDLE_DIR,
		planPath: DEFAULT_PLAN_PATH,
		upstreamApiUrl: DEFAULT_API_URL,
		skipUpstream: false,
		allowOfficialSdkPlaceholder: false,
		requireRegistered: false,
		requireBuildPlanProvenance: false,
		requireSourceBootstrapProvenance: false,
		requireBrowserBuildCommandProvenance: false,
		requireBrowserBuildExecutionProvenance: false,
		requireBrowserBuildLogProvenance: false,
		requireBaselineProvenance: false,
		requireCompressedManifest: false,
		requireBrowserCompilerContracts: false,
		runBrowserContract: false,
		probeToolchain: false,
		probeToolchainRunWasm: false,
		minFreeGiB: DEFAULT_MIN_SWIFT_BUILD_FREE_GIB,
		upstreamReceiptPath: null,
		json: false
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--') {
			continue;
		} else if (arg === '--help') {
			return { help: true };
		} else if (arg === '--build-dir') {
			options.buildDir = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--bundle-dir') {
			options.bundleDir = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--plan') {
			options.planPath = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--skip-upstream') {
			options.skipUpstream = true;
		} else if (arg === '--upstream-api-url') {
			options.upstreamApiUrl = readOptionValue(argv, index, arg);
			assertHttpUrl(options.upstreamApiUrl, arg);
			index += 1;
		} else if (arg === '--allow-official-sdk-placeholder') {
			options.allowOfficialSdkPlaceholder = true;
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
		} else if (arg === '--require-browser-compiler-contracts') {
			options.requireBrowserCompilerContracts = true;
		} else if (arg === '--browser-contract') {
			options.runBrowserContract = true;
		} else if (arg === '--probe-toolchain') {
			options.probeToolchain = true;
		} else if (arg === '--probe-toolchain-run-wasm') {
			options.probeToolchain = true;
			options.probeToolchainRunWasm = true;
		} else if (arg === '--timeout-ms') {
			options.timeoutMs = Number(readOptionValue(argv, index, arg));
			assertTimeoutMs(options.timeoutMs);
			index += 1;
		} else if (arg === '--min-free-gib') {
			options.minFreeGiB = Number(readOptionValue(argv, index, arg));
			if (!Number.isFinite(options.minFreeGiB) || options.minFreeGiB < 0) {
				throw new Error('--min-free-gib must be a non-negative number');
			}
			index += 1;
		} else if (arg === '--upstream-receipt') {
			options.upstreamReceiptPath = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--json') {
			options.json = true;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	assertTimeoutMs(options.timeoutMs);
	assertSwiftDoctorOptionCombination(options);
	return options;
}

export function buildSwiftDoctorNextActions(report) {
	const actions = [];
	const buildPlan = report.buildPlan ?? { valid: true };
	if (!report.upstream.checked && !report.readiness.ready) {
		actions.push(
			'Re-run doctor without --skip-upstream, or with --upstream-api-url for a pinned release, before making a Swift registration decision.'
		);
	}
	if (report.upstream.checked && report.upstream.error) {
		actions.push(
			'Fix Swift upstream discovery before making a registration decision; check the release API URL, network access, and GitHub API availability.'
		);
	}
	if (
		report.upstream.checked &&
		report.upstream.ok &&
		!report.upstream.hasBrowserCompilerBundle
	) {
		actions.push(
			'Build or source a real browser-hosted Swift compiler bundle; upstream currently exposes SDK artifacts, not swiftc.wasm/swiftpm.wasm.'
		);
	}
	if (report.disk && !report.disk.ok) {
		actions.push(
			`Use a larger Swift build workspace before running source checkout or upstream baseline builds; ${report.disk.probePath} has ${report.disk.freeBytes === null ? 'unknown free space' : `${formatGiB(report.disk.freeBytes)} GiB free`} and the current threshold is ${report.disk.minFreeGiB} GiB.`
		);
		actions.push(
			'For an external disk, run bootstrap:wasm-swift-source with --source-root /path/to/large-disk/swift-source-root, then build:wasm-swift-browser-compiler with --checkout-root /path/to/large-disk/swift-source-root --build-dir /path/to/large-disk/browser-compiler-build and pass that same --plan path to run:wasm-swift-upstream-baseline and package-sync:wasm-swift-from-plan:strict.'
		);
	}
	if (report.upstream.checked && report.upstream.sdkArtifactsMissingChecksums?.length > 0) {
		actions.push(
			'Do not use upstream Swift Wasm SDK artifacts without matching .sha256 sidecars; provide a checksum before packaging provenance.'
		);
	}
	if (report.upstream.checked && report.upstream.sdkArtifactsNotGzip?.length > 0) {
		actions.push(
			'Do not copy upstream Swift Wasm SDK zip artifactbundles directly to sdk.tar.gz; use a verified tar.gz SDK artifact or an explicit conversion step with provenance.'
		);
	}
	if (!report.buildOutputs.ready) {
		if (!report.toolchain?.checked) {
			actions.push(
				'Run pnpm --dir runtime/swift run probe:toolchain to verify the native Swift/Wasm SDK baseline; if Swift is missing, run pnpm --dir runtime/swift run probe:install for the install commands.'
			);
		} else if (!report.toolchain.ok) {
			actions.push(
				'Fix the native Swift/Wasm SDK baseline before browser compiler build work; run pnpm --dir runtime/swift run probe:install for the install commands.'
			);
		}
		actions.push(
			'If no Swift monorepo checkout exists yet, run bootstrap:wasm-swift-source with --source-root on a large workspace, then pass that checkout to build:wasm-swift-browser-compiler with the browser_build_command that produces runner-worker.js, swiftc.wasm, and swiftpm.wasm.'
		);
		actions.push(
			'Run build:wasm-swift-browser-compiler, run run:wasm-swift-upstream-baseline for a native Swift/WASI baseline receipt, then run discover:wasm-swift-build-outputs -- --write-plan against the build directory.'
		);
	}
	if (!buildPlan.valid) {
		actions.push(
			'Run build:wasm-swift-browser-compiler to write a current build plan, then re-run doctor with --require-browser-compiler-contracts.'
		);
	}
	if (report.buildOutputs.ready && buildPlan.valid && !report.readiness.ready) {
		actions.push(
			'Run package-sync:wasm-swift-from-plan:strict with build provenance after the verified build plan is ready.'
		);
	}
	if (report.readiness.ready && !report.readiness.registered) {
		actions.push(
			'Register SWIFT only after the browser contract remains green; use promote:wasm-swift for a strict exported descriptor handoff, or apply:wasm-swift-registration when the candidate is already synced and reviewed.'
		);
	}
	if (actions.length === 0) {
		actions.push('Swift runtime readiness is green for the selected checks.');
	}
	return actions;
}

export async function runSwiftDoctor({
	buildDir = DEFAULT_BUILD_DIR,
	bundleDir = DEFAULT_BUNDLE_DIR,
	planPath = DEFAULT_PLAN_PATH,
	upstreamApiUrl = DEFAULT_API_URL,
	skipUpstream = false,
	allowOfficialSdkPlaceholder = false,
	requireRegistered = false,
	requireBuildPlanProvenance = false,
	requireSourceBootstrapProvenance = false,
	requireBrowserBuildCommandProvenance = false,
	requireBrowserBuildExecutionProvenance = false,
	requireBrowserBuildLogProvenance = false,
	requireBaselineProvenance = false,
	requireCompressedManifest = false,
	requireBrowserCompilerContracts = false,
	runBrowserContract = false,
	probeToolchain = false,
	probeToolchainRunWasm = false,
	minFreeGiB = DEFAULT_MIN_SWIFT_BUILD_FREE_GIB,
	timeoutMs,
	upstreamReceiptPath,
	fetchImpl,
	inspectDiskSpace = inspectFreeDiskSpace,
	toolchainProbe = probeSwiftToolchain
} = {}) {
	assertHttpUrl(upstreamApiUrl, 'upstreamApiUrl');
	assertSwiftDoctorOptionCombination({ skipUpstream, upstreamApiUrl, upstreamReceiptPath });
	const toolchain = {
		checked: !!probeToolchain,
		ok: false,
		runWasm: !!probeToolchainRunWasm,
		...swiftWasmMetadata(),
		hostSwift: null,
		selectedSdk: null,
		wasmBytes: null,
		runStdout: null,
		error: null
	};
	if (probeToolchain) {
		try {
			const result = await toolchainProbe({ runWasm: probeToolchainRunWasm });
			toolchain.ok = true;
			toolchain.hostSwift = result.hostSwift ?? null;
			toolchain.selectedSdk = result.selectedSdk ?? null;
			toolchain.wasmBytes = result.wasmBytes ?? null;
			toolchain.runStdout = result.runStdout ?? null;
		} catch (error) {
			toolchain.error = error instanceof Error ? error.message : String(error);
		}
	}
	let disk;
	try {
		disk = await inspectDiskSpace(buildDir, { minFreeGiB });
	} catch (error) {
		disk = {
			probePath: path.resolve(buildDir),
			freeBytes: null,
			requiredFreeBytes: null,
			minFreeGiB,
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
	const upstream = {
		checked: !skipUpstream,
		apiUrl: upstreamApiUrl,
		ok: false,
		receiptPath: null,
		hasBrowserCompilerBundle: false,
		tagName: null,
		sdkArtifacts: [],
		sdkArtifactsMissingChecksums: [],
		sdkArtifactsNotGzip: [],
		ignoredArtifactBundles: [],
		browserCompilerCandidates: [],
		error: null
	};
	if (!skipUpstream) {
		try {
			const result = await discoverSwiftUpstreamAssets({ apiUrl: upstreamApiUrl, fetchImpl });
			if (upstreamReceiptPath) {
				const written = await writeSwiftUpstreamDiscoveryReceipt(upstreamReceiptPath, result, {
					apiUrl: upstreamApiUrl
				});
				upstream.receiptPath = written.receiptPath;
			}
			upstream.ok = true;
			upstream.hasBrowserCompilerBundle = result.hasBrowserCompilerBundle;
			upstream.tagName = result.tagName;
			upstream.sdkArtifacts = result.sdkArtifacts;
			upstream.sdkArtifactsMissingChecksums = result.sdkArtifactsMissingChecksums;
			upstream.sdkArtifactsNotGzip = result.sdkArtifactsNotGzip;
			upstream.ignoredArtifactBundles = result.ignoredArtifactBundles;
			upstream.browserCompilerCandidates = result.browserCompilerCandidates;
		} catch (error) {
			upstream.error = error instanceof Error ? error.message : String(error);
		}
	}

	let buildOutputs;
	try {
		buildOutputs = await discoverSwiftBrowserBuildOutputs({
			buildDir,
			allowOfficialSdkPlaceholder
		});
	} catch (error) {
		buildOutputs = {
			buildDir: path.resolve(buildDir),
			ready: false,
			expectedOutputs: {},
			candidates: {},
			validationErrors: {},
			missing: ['runner-worker.js', 'swiftc.wasm', 'swiftpm.wasm', 'sdk.tar.gz'],
			error: error instanceof Error ? error.message : String(error)
		};
	}

	const normalizedPlanPath = path.resolve(planPath);
	let buildPlan;
	try {
		const plan = JSON.parse(await readFile(normalizedPlanPath, 'utf8'));
		const errors = validateSwiftBrowserBuildPlan(plan, {
			requireBrowserCompilerContracts,
			requireBrowserBuildCommand: requireBrowserBuildCommandProvenance,
			requireBrowserBuildExecution: requireBrowserBuildExecutionProvenance
		});
		buildPlan = {
			planPath: normalizedPlanPath,
			checked: true,
			valid: errors.length === 0,
			errors,
			format: plan?.format ?? null,
			hasBrowserCompilerContracts: Array.isArray(plan?.browserCompilerBuild?.requiredOutputs)
		};
	} catch (error) {
		buildPlan = {
			planPath: normalizedPlanPath,
			checked: true,
			valid: false,
			errors: [
				`Swift browser build plan could not be read from ${normalizedPlanPath}: ${
					error instanceof Error ? error.message : String(error)
				}`
			],
			format: null,
			hasBrowserCompilerContracts: false
		};
	}

	let readiness;
	try {
		readiness = await checkSwiftReadiness({
			bundleDir,
			requireRegistered,
			requireBuildPlanProvenance,
			requireSourceBootstrapProvenance,
			requireBrowserBuildCommandProvenance,
			requireBrowserBuildExecutionProvenance,
			requireBrowserBuildLogProvenance,
			requireBaselineProvenance,
			requireCompressedManifest,
			runBrowserContract,
			timeoutMs
		});
	} catch (error) {
		readiness = {
			ready: false,
			registered: false,
			bundleDir: path.resolve(bundleDir),
			assetVersion: '',
			manifestValidated: false,
			browserContractValidated: false,
			errors: [error instanceof Error ? error.message : String(error)],
			warnings: []
		};
	}

	const report = {
		ready: buildOutputs.ready && buildPlan.valid && readiness.ready,
		toolchain,
		disk,
		upstream,
		buildOutputs,
		buildPlan,
		readiness,
		nextActions: []
	};
	report.nextActions = buildSwiftDoctorNextActions(report);
	return report;
}

function formatList(items, formatItem) {
	if (!items || items.length === 0) return 'none';
	return items.map(formatItem).join(', ');
}

function formatBuildOutputValidationErrors(validationErrors) {
	const entries = Object.entries(validationErrors || {}).flatMap(([kind, candidates]) =>
		(candidates || []).map((candidate) => ({
			kind,
			path: candidate.path,
			errors: candidate.errors || []
		}))
	);
	if (entries.length === 0) return [];
	return entries.map(
		(entry) => `  validation error: ${entry.kind} candidate ${entry.path}: ${entry.errors.join('; ')}`
	);
}

function formatReadinessProvenance(provenance) {
	const lines = [];
	if (provenance?.buildPlan) {
		lines.push(
			`  build plan provenance: ${provenance.buildPlan.usedSnapshot ? 'snapshot' : 'original'} (${provenance.buildPlan.sourcePath})`
		);
	}
	if (provenance?.sourceBootstrapReceipt) {
		lines.push(
			`  source bootstrap receipt: ${
				provenance.sourceBootstrapReceipt.usedSnapshot ? 'snapshot' : 'original'
			} (${provenance.sourceBootstrapReceipt.sourcePath})`
		);
	}
	if (provenance?.browserBuildLog) {
		lines.push(
			`  browser build log: ${
				provenance.browserBuildLog.usedSnapshot ? 'snapshot' : 'original'
			} (${provenance.browserBuildLog.sourcePath})`
		);
	}
	for (const receipt of provenance?.baselineReceipts || []) {
		lines.push(
			`  baseline ${receipt.preset}: ${receipt.usedSnapshot ? 'snapshot' : 'original'} (${receipt.sourcePath})`
		);
	}
	return lines;
}

export function formatSwiftDoctorReport(report) {
	const lines = [
		'Swift runtime doctor',
		'',
		'Toolchain:',
		report.toolchain?.checked ? '  checked: yes' : '  checked: no',
		`  expected Swift: ${report.toolchain?.swiftVersion ?? 'unknown'}`,
		`  expected SDK: ${report.toolchain?.wasmSdkId ?? 'unknown'}`,
		report.toolchain?.checked ? `  ready: ${report.toolchain.ok ? 'yes' : 'no'}` : null,
		report.toolchain?.hostSwift ? `  host Swift: ${report.toolchain.hostSwift}` : null,
		report.toolchain?.selectedSdk ? `  selected SDK: ${report.toolchain.selectedSdk}` : null,
		Number.isFinite(report.toolchain?.wasmBytes)
			? `  wasm bytes: ${report.toolchain.wasmBytes}`
			: null,
		report.toolchain?.runStdout ? `  run stdout: ${JSON.stringify(report.toolchain.runStdout)}` : null,
		report.toolchain?.error ? `  error: ${report.toolchain.error}` : null,
		'',
		'Disk:',
		`  probe: ${report.disk?.probePath ?? 'unknown'}`,
		`  minimum free: ${report.disk?.minFreeGiB ?? DEFAULT_MIN_SWIFT_BUILD_FREE_GIB} GiB`,
		report.disk?.freeBytes === null || report.disk?.freeBytes === undefined
			? '  free: unknown'
			: `  free: ${formatGiB(report.disk.freeBytes)} GiB`,
		`  large Swift builds: ${report.disk?.ok ? 'yes' : 'no'}`,
		report.disk?.error ? `  error: ${report.disk.error}` : null,
		'',
		'Upstream:',
		report.upstream.checked
			? `  release: ${report.upstream.tagName ?? 'unknown'}`
			: '  release: skipped',
		report.upstream.checked ? `  api: ${report.upstream.apiUrl}` : null,
		report.upstream.receiptPath ? `  receipt: ${report.upstream.receiptPath}` : null,
		report.upstream.checked
			? `  SDK artifacts: ${formatList(report.upstream.sdkArtifacts, (asset) => asset.name)}`
			: null,
		report.upstream.checked
			? `  SDK artifacts missing checksums: ${formatList(
					report.upstream.sdkArtifactsMissingChecksums,
					(asset) => asset.name
				)}`
			: null,
		report.upstream.checked
			? `  SDK artifacts not usable as sdk.tar.gz: ${formatList(
					report.upstream.sdkArtifactsNotGzip,
					(asset) => asset.name
				)}`
			: null,
		report.upstream.checked
			? `  ignored non-Wasm artifact bundles: ${formatList(
					report.upstream.ignoredArtifactBundles,
					(asset) => asset.name
				)}`
			: null,
		report.upstream.checked
			? `  browser compiler candidates: ${formatList(
					report.upstream.browserCompilerCandidates,
					(asset) => asset.name
				)}`
			: null,
		report.upstream.error ? `  error: ${report.upstream.error}` : null,
		'',
		'Build outputs:',
		`  directory: ${report.buildOutputs.buildDir}`,
		`  ready: ${report.buildOutputs.ready ? 'yes' : 'no'}`,
		report.buildOutputs.error ? `  error: ${report.buildOutputs.error}` : null,
		report.buildOutputs.missing?.length
			? `  missing: ${report.buildOutputs.missing.join(', ')}`
			: null,
		...formatBuildOutputValidationErrors(report.buildOutputs.validationErrors),
		'',
		'Build plan:',
		`  plan: ${report.buildPlan.planPath}`,
		`  valid: ${report.buildPlan.valid ? 'yes' : 'no'}`,
		`  browser compiler contracts: ${
			report.buildPlan.hasBrowserCompilerContracts ? 'yes' : 'no'
		}`,
		...(report.buildPlan.errors || []).map((error) => `  error: ${error}`),
		'',
		'Readiness:',
		`  bundle: ${report.readiness.bundleDir}`,
		`  asset version: ${report.readiness.assetVersion || 'missing'}`,
		`  ready: ${report.readiness.ready ? 'yes' : 'no'}`,
		...formatReadinessProvenance(report.readiness.provenance),
		...(report.readiness.warnings || []).map((warning) => `  warning: ${warning}`),
		...(report.readiness.errors || []).map((error) => `  error: ${error}`),
		'',
		'Next actions:',
		...report.nextActions.map((action) => `  - ${action}`)
	];
	return lines.filter((line) => line !== null).join('\n');
}

function usage() {
	return [
		'Usage: pnpm --dir runtime/swift run doctor -- [options]',
		'',
		'Checks the current Swift runtime path: upstream release assets, local browser compiler',
		'build outputs, and the synced app bundle readiness gate.',
		'',
		'Options:',
		'  --build-dir <dir>                 Swift browser compiler build output directory',
		'  --bundle-dir <dir>                Synced app bundle directory',
		'  --plan <file>                     Swift browser compiler build plan',
		'  --skip-upstream                   Do not call the GitHub releases API',
		'  --upstream-api-url <url>          GitHub release API URL for upstream discovery',
		'  --allow-official-sdk-placeholder  Accept official-swift-wasm-sdk for sdk.tar.gz discovery',
		'  --require-registered              Require SWIFT app registration during readiness',
		'  --require-build-plan-provenance   Require build-plan path, sha256, and contracts during readiness',
		'  --require-source-bootstrap-provenance',
		'                                    Require source bootstrap receipt provenance during readiness',
		'  --require-browser-build-command-provenance',
		'                                    Require browserCompilerBuild.command provenance in the build plan',
		'  --require-browser-build-execution-provenance',
		'                                    Require browserCompilerBuild.execution provenance in the build plan',
		'  --require-browser-build-log-provenance',
		'                                    Require browser build log provenance during readiness',
		'  --require-compressed-manifest     Require Swift compiler gzip assets in the compressed runtime manifest during readiness',
		'  --require-browser-compiler-contracts',
		'                                    Require build plan output contracts',
		'  --browser-contract                Run the browser worker contract during readiness',
		'  --probe-toolchain                 Compile the native Swift/Wasm SDK stdin probe',
		'  --probe-toolchain-run-wasm        Also execute the native Swift/Wasm SDK stdin probe',
		`  --min-free-gib <n>                Free-space threshold for large Swift build diagnostics (default ${DEFAULT_MIN_SWIFT_BUILD_FREE_GIB})`,
		'  --timeout-ms <ms>                 Browser contract timeout',
		'  --upstream-receipt <file>         Write upstream discovery receipt JSON',
		'  --json                            Print the full report as JSON'
	].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		const options = parseSwiftDoctorArgs(process.argv.slice(2));
		if (options.help) {
			console.log(usage());
		} else {
			const report = await runSwiftDoctor(options);
			console.log(options.json ? JSON.stringify(report, null, 2) : formatSwiftDoctorReport(report));
			if (!report.ready) process.exitCode = 1;
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
