import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
	BUILD_PLAN_SNAPSHOT_FILE,
	BROWSER_BUILD_LOG_SNAPSHOT_FILE,
	SOURCE_BOOTSTRAP_RECEIPT_SNAPSHOT_FILE,
	swiftBaselineReceiptSnapshotFile
} from './runtime-build-info.mjs';
import { validateSwiftBrowserBuildPlan } from './verify-build-outputs.mjs';

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

async function readProvenanceFile(originalPath, snapshotPath) {
	let bytes = await readFile(originalPath).catch(() => null);
	let sourcePath = originalPath;
	if (!bytes && snapshotPath) {
		bytes = await readFile(snapshotPath).catch(() => null);
		sourcePath = snapshotPath;
	}
	return { bytes, sourcePath, usedSnapshot: !!bytes && sourcePath !== originalPath };
}

function parseIsoTimestamp(value) {
	if (typeof value !== 'string') return null;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
		? timestamp
		: null;
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
		return { planPath: null, plan: null, errors: ['runtime-build.json build plan provenance is required'] };
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
	const result = await readProvenanceFile(planPath, snapshotPath);
	if (!result.bytes) {
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
	const actualDigest = sha256(result.bytes);
	if (actualDigest !== match.sha256) {
		return {
			planPath,
			plan: null,
			errors: [
				`runtime-build.json build plan sha256 mismatch for ${result.sourcePath}: expected ${match.sha256}, got ${actualDigest}`
			]
		};
	}
	let plan;
	try {
		plan = JSON.parse(result.bytes.toString('utf8'));
	} catch (error) {
		return {
			planPath,
			plan: null,
			errors: [
				`runtime-build.json build plan could not be parsed at ${result.sourcePath}: ${error.message}`
			]
		};
	}
	const errors = validateSwiftBrowserBuildPlan(plan, {
		requireBrowserCompilerContracts: true,
		requireBrowserBuildCommand,
		requireBrowserBuildExecution,
		requireSourceBootstrapProvenance
	}).map((error) => `runtime-build.json build plan ${error}`);
	return { planPath, plan, ...result, errors };
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
		const { preset, receiptPath, sha256: expectedDigest } = match.groups;
		const normalizedPath = receiptPath.trim();
		if (!path.isAbsolute(normalizedPath)) {
			errors.push(`runtime-build.json upstream baseline receipt path must be absolute for ${preset}`);
			continue;
		}
		const snapshotPath = bundleDir
			? path.join(bundleDir, swiftBaselineReceiptSnapshotFile(preset))
			: null;
		const result = await readProvenanceFile(normalizedPath, snapshotPath);
		if (!result.bytes) {
			errors.push(
				snapshotPath
					? `runtime-build.json upstream baseline receipt file was not found: ${normalizedPath}; fallback snapshot was not found at ${snapshotPath}`
					: `runtime-build.json upstream baseline receipt file was not found: ${normalizedPath}`
			);
			continue;
		}
		const actualDigest = sha256(result.bytes);
		if (actualDigest !== expectedDigest) {
			errors.push(
				`runtime-build.json upstream baseline receipt sha256 mismatch for ${result.sourcePath}: expected ${expectedDigest}, got ${actualDigest}`
			);
			continue;
		}
		let receipt;
		try {
			receipt = JSON.parse(result.bytes.toString('utf8'));
		} catch (error) {
			errors.push(
				`runtime-build.json upstream baseline receipt could not be parsed at ${result.sourcePath}: ${error.message}`
			);
			continue;
		}
		receipts.push({ preset, receiptPath: normalizedPath, ...result });
		if (receipt?.format !== 'wasm-idle-swift-upstream-baseline-build-v1') {
			errors.push(`runtime-build.json upstream baseline receipt format is invalid for ${normalizedPath}`);
		}
		if (receipt?.preset !== preset) {
			errors.push(
				`runtime-build.json upstream baseline receipt preset ${receipt?.preset ?? 'missing'} does not match ${preset}`
			);
		}
		if (typeof receipt?.planPath !== 'string' || !path.isAbsolute(receipt.planPath)) {
			errors.push(`runtime-build.json upstream baseline receipt planPath must be absolute for ${preset}`);
		} else if (expectedBuildPlanPath && receipt.planPath !== expectedBuildPlanPath) {
			errors.push(
				`runtime-build.json upstream baseline receipt planPath ${receipt.planPath} does not match build plan provenance ${expectedBuildPlanPath} for ${preset}`
			);
		}
		const expectedCommand = expectedCommands.get(preset);
		if (!Array.isArray(receipt?.command) || receipt.command.length === 0) {
			errors.push(`runtime-build.json upstream baseline receipt command must be a non-empty string array for ${preset}`);
		} else if (expectedCommand && JSON.stringify(receipt.command) !== JSON.stringify(expectedCommand)) {
			errors.push(`runtime-build.json upstream baseline receipt command does not match build plan command for ${preset}`);
		}
		if (typeof receipt?.cwd !== 'string' || !path.isAbsolute(receipt.cwd)) {
			errors.push(`runtime-build.json upstream baseline receipt cwd must be absolute for ${preset}`);
		}
		if (receipt?.status !== 'passed') {
			errors.push(`runtime-build.json upstream baseline receipt status must be passed for ${preset}`);
		}
		if (receipt?.status === 'passed' && receipt?.exitCode !== 0) {
			errors.push(`runtime-build.json upstream baseline receipt exitCode must be 0 for ${preset}`);
		}
		const startedAt = parseIsoTimestamp(receipt?.startedAt);
		const finishedAt = parseIsoTimestamp(receipt?.finishedAt);
		if (startedAt === null) errors.push(`runtime-build.json upstream baseline receipt startedAt must be an ISO timestamp for ${preset}`);
		if (finishedAt === null) errors.push(`runtime-build.json upstream baseline receipt finishedAt must be an ISO timestamp for ${preset}`);
		if (startedAt !== null && finishedAt !== null && finishedAt < startedAt) {
			errors.push(`runtime-build.json upstream baseline receipt finishedAt must not be before startedAt for ${preset}`);
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
		return { receipt: null, errors: ['runtime-build.json source bootstrap receipt provenance is required'] };
	}
	const receiptPath = match.receiptPath.trim();
	if (!path.isAbsolute(receiptPath)) {
		return { receipt: null, errors: ['runtime-build.json source bootstrap receipt path must be absolute'] };
	}
	const snapshotPath = bundleDir
		? path.join(bundleDir, SOURCE_BOOTSTRAP_RECEIPT_SNAPSHOT_FILE)
		: null;
	const result = await readProvenanceFile(receiptPath, snapshotPath);
	if (!result.bytes) {
		return {
			receipt: null,
			errors: [
				snapshotPath
					? `runtime-build.json source bootstrap receipt file was not found: ${receiptPath}; fallback snapshot was not found at ${snapshotPath}`
					: `runtime-build.json source bootstrap receipt file was not found: ${receiptPath}`
			]
		};
	}
	const actualDigest = sha256(result.bytes);
	if (actualDigest !== match.sha256) {
		return {
			receipt: null,
			errors: [
				`runtime-build.json source bootstrap receipt sha256 mismatch for ${result.sourcePath}: expected ${match.sha256}, got ${actualDigest}`
			]
		};
	}
	let receipt;
	try {
		receipt = JSON.parse(result.bytes.toString('utf8'));
	} catch (error) {
		return {
			receipt: null,
			errors: [
				`runtime-build.json source bootstrap receipt could not be parsed at ${result.sourcePath}: ${error.message}`
			]
		};
	}
	const errors = [];
	if (receipt?.format !== 'wasm-idle-swift-source-bootstrap-receipt-v1') errors.push('runtime-build.json source bootstrap receipt format is invalid');
	if (receipt?.status !== 'passed') errors.push('runtime-build.json source bootstrap receipt status must be passed');
	if (typeof receipt?.sourceRoot !== 'string' || !path.isAbsolute(receipt.sourceRoot)) errors.push('runtime-build.json source bootstrap receipt sourceRoot must be absolute');
	for (const field of ['swiftRepository', 'swiftRef', 'dependencyScheme']) {
		if (typeof receipt?.[field] !== 'string' || receipt[field].trim().length === 0) errors.push(`runtime-build.json source bootstrap receipt ${field} is required`);
	}
	const startedAt = parseIsoTimestamp(receipt?.startedAt);
	const finishedAt = parseIsoTimestamp(receipt?.finishedAt);
	if (startedAt === null) errors.push('runtime-build.json source bootstrap receipt startedAt must be an ISO timestamp');
	if (finishedAt === null) errors.push('runtime-build.json source bootstrap receipt finishedAt must be an ISO timestamp');
	if (startedAt !== null && finishedAt !== null && finishedAt < startedAt) errors.push('runtime-build.json source bootstrap receipt finishedAt must not be before startedAt');
	if (receipt?.checkout?.ok !== true) errors.push('runtime-build.json source bootstrap receipt checkout.ok must be true');
	if (expectedSourceBootstrap && typeof expectedSourceBootstrap === 'object') {
		if (expectedSourceBootstrap.path !== receiptPath) errors.push(`runtime-build.json source bootstrap receipt path ${receiptPath} does not match build plan sourceBootstrap.path ${expectedSourceBootstrap.path}`);
		for (const field of ['sourceRoot', 'swiftRepository', 'swiftRef', 'dependencyScheme']) {
			if (expectedSourceBootstrap[field] !== receipt?.[field]) errors.push(`runtime-build.json source bootstrap receipt ${field} does not match build plan sourceBootstrap.${field}`);
		}
	}
	return { receipt: { receiptPath, ...result }, errors };
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
	if (!match) return { log: null, errors: ['runtime-build.json browser build log provenance is required'] };
	const logPath = match.logPath.trim();
	if (!path.isAbsolute(logPath)) return { log: null, errors: ['runtime-build.json browser build log path must be absolute'] };
	const snapshotPath = bundleDir ? path.join(bundleDir, BROWSER_BUILD_LOG_SNAPSHOT_FILE) : null;
	const result = await readProvenanceFile(logPath, snapshotPath);
	if (!result.bytes) {
		return {
			log: null,
			errors: [
				snapshotPath
					? `runtime-build.json browser build log file was not found: ${logPath}; fallback snapshot was not found at ${snapshotPath}`
					: `runtime-build.json browser build log file was not found: ${logPath}`
			]
		};
	}
	const actualDigest = sha256(result.bytes);
	if (actualDigest !== match.sha256) {
		return {
			log: null,
			errors: [
				`runtime-build.json browser build log sha256 mismatch for ${result.sourcePath}: expected ${match.sha256}, got ${actualDigest}`
			]
		};
	}
	return { log: { logPath, ...result }, errors: [] };
}
