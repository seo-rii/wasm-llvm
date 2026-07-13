#!/usr/bin/env node
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	validateSwiftCompilerWasmModuleBytes,
	validateSwiftRunnerWorkerSource,
	validateSwiftSdkArchiveBytes
} from './runtime-manifest.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const RUNTIME_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const DEFAULT_BUILD_DIR = path.join(RUNTIME_ROOT, 'browser-compiler-build');
const DEFAULT_PLAN_PATH = path.join(
	DEFAULT_BUILD_DIR,
	'wasm-idle-swift-browser-build-plan.json'
);
const BUILD_PLAN_FORMAT = 'wasm-idle-swift-browser-compiler-build-plan-v1';
const OFFICIAL_SDK_PLACEHOLDER = 'official-swift-wasm-sdk';

function readOptionValue(argv, index, optionName) {
	const value = argv[index + 1];
	if (typeof value !== 'string' || !value || value.startsWith('--')) {
		throw new Error(`${optionName} requires a value`);
	}
	return value;
}

async function collectFiles(dir) {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const files = [];
	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectFiles(entryPath)));
		} else if (entry.isFile()) {
			files.push(entryPath);
		}
	}
	return files.sort();
}

function scoreCandidate(filePath, kind) {
	const basename = path.basename(filePath).toLowerCase();
	const normalized = filePath.toLowerCase();
	if (kind === 'runner-worker.js') {
		if (basename === 'runner-worker.js') return 100;
		if (basename.endsWith('.js') && /runner.*worker/u.test(normalized)) return 50;
		return 0;
	}
	if (kind === 'swiftc.wasm') {
		if (basename === 'swiftc.wasm') return 100;
		if (basename.endsWith('.wasm') && /swiftc/u.test(basename)) return 50;
		return 0;
	}
	if (kind === 'swiftpm.wasm') {
		if (basename === 'swiftpm.wasm') return 100;
		if (basename.endsWith('.wasm') && /swiftpm|swift-package/u.test(basename)) return 50;
		return 0;
	}
	if (kind === 'sdk.tar.gz') {
		if (basename === 'sdk.tar.gz') return 100;
		if (basename.endsWith('.tar.gz') && /sdk|artifactbundle/u.test(basename)) return 50;
		return 0;
	}
	return 0;
}

async function validateCandidate(filePath, kind) {
	const bytes = await readFile(filePath).catch(() => null);
	if (!bytes) return [`${kind} candidate could not be read: ${filePath}`];
	if (kind === 'runner-worker.js') {
		return validateSwiftRunnerWorkerSource(bytes.toString('utf8'));
	}
	if (kind.endsWith('.wasm')) {
		return validateSwiftCompilerWasmModuleBytes(bytes, kind);
	}
	if (kind === 'sdk.tar.gz') {
		return validateSwiftSdkArchiveBytes(bytes, kind);
	}
	return [`unsupported Swift browser build output kind: ${kind}`];
}

export function parseDiscoverBuildOutputsArgs(argv) {
	const options = {
		buildDir: DEFAULT_BUILD_DIR,
		planPath: DEFAULT_PLAN_PATH,
		writePlan: false,
		allowOfficialSdkPlaceholder: false,
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
		} else if (arg === '--plan') {
			options.planPath = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--write-plan') {
			options.writePlan = true;
		} else if (arg === '--allow-official-sdk-placeholder') {
			options.allowOfficialSdkPlaceholder = true;
		} else if (arg === '--json') {
			options.json = true;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

export async function discoverSwiftBrowserBuildOutputs({
	buildDir = DEFAULT_BUILD_DIR,
	allowOfficialSdkPlaceholder = false
} = {}) {
	const normalizedBuildDir = path.resolve(buildDir);
	const buildStats = await stat(normalizedBuildDir).catch(() => null);
	if (!buildStats?.isDirectory()) {
		throw new Error(`Swift browser compiler build directory was not found: ${normalizedBuildDir}`);
	}
	const files = await collectFiles(normalizedBuildDir);
	const candidates = {};
	const validationErrors = {};
	const expectedOutputs = {};
	const missing = [];
	for (const kind of ['runner-worker.js', 'swiftc.wasm', 'swiftpm.wasm', 'sdk.tar.gz']) {
		const scored = files
			.map((filePath) => ({ filePath, score: scoreCandidate(filePath, kind) }))
			.filter((candidate) => candidate.score > 0)
			.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));
		candidates[kind] = scored.map((candidate) => candidate.filePath);
		validationErrors[kind] = [];
		let selected = null;
		for (const candidate of scored) {
			const errors = await validateCandidate(candidate.filePath, kind);
			if (errors.length === 0) {
				selected = candidate.filePath;
				break;
			}
			validationErrors[kind].push({ path: candidate.filePath, errors });
		}
		if (selected) {
			expectedOutputs[kind] = selected;
		} else if (kind === 'sdk.tar.gz' && allowOfficialSdkPlaceholder) {
			expectedOutputs[kind] = OFFICIAL_SDK_PLACEHOLDER;
		} else {
			expectedOutputs[kind] = null;
			missing.push(kind);
		}
	}
	return {
		buildDir: normalizedBuildDir,
		expectedOutputs,
		candidates,
		validationErrors,
		missing,
		ready: missing.length === 0
	};
}

export async function writeDiscoveredOutputsToPlan({ planPath, discovery }) {
	const normalizedPlanPath = path.resolve(planPath);
	const plan = JSON.parse(await readFile(normalizedPlanPath, 'utf8'));
	if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
		throw new Error('Swift browser build plan must be an object');
	}
	if (plan.format !== BUILD_PLAN_FORMAT) {
		throw new Error(`Swift browser build plan format must be ${BUILD_PLAN_FORMAT}`);
	}
	plan.buildDir = discovery.buildDir;
	plan.expectedOutputs = discovery.expectedOutputs;
	if (Array.isArray(plan.browserCompilerBuild?.requiredOutputs)) {
		plan.browserCompilerBuild.requiredOutputs = plan.browserCompilerBuild.requiredOutputs.map((output) =>
			output && typeof output === 'object' && !Array.isArray(output) && output.name in discovery.expectedOutputs
				? { ...output, expectedPath: discovery.expectedOutputs[output.name] }
				: output
		);
	}
	plan.discoveredOutputs = {
		candidates: discovery.candidates,
		validationErrors: discovery.validationErrors,
		missing: discovery.missing
	};
	await mkdir(path.dirname(normalizedPlanPath), { recursive: true });
	await writeFile(normalizedPlanPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
	return { planPath: normalizedPlanPath, plan };
}

function formatDiscovery(discovery) {
	return [
		`Build directory: ${discovery.buildDir}`,
		`runner-worker.js: ${discovery.expectedOutputs['runner-worker.js'] ?? 'missing'}`,
		`swiftc.wasm: ${discovery.expectedOutputs['swiftc.wasm'] ?? 'missing'}`,
		`swiftpm.wasm: ${discovery.expectedOutputs['swiftpm.wasm'] ?? 'missing'}`,
		`sdk.tar.gz: ${discovery.expectedOutputs['sdk.tar.gz'] ?? 'missing'}`,
		`Validation errors: ${Object.values(discovery.validationErrors)
			.flat()
			.map((entry) => `${entry.path} (${entry.errors.join('; ')})`)
			.join(' | ') || 'none'}`,
		`Ready: ${discovery.ready ? 'yes' : 'no'}`
	].join('\n');
}

function usage() {
	return [
		'Usage: pnpm --dir runtime/swift run discover:build-outputs -- [options]',
		'',
		'Scans a Swift browser compiler build directory for runner-worker.js, swiftc.wasm,',
		'swiftpm.wasm, and sdk.tar.gz candidates, validates their signatures/contracts,',
		'and can write the discovered paths back into a build plan.',
		'',
		'Options:',
		'  --build-dir <dir>                 Build output directory to scan',
		'  --plan <file>                     Build plan to update with --write-plan',
		'  --write-plan                      Write discovered expectedOutputs into the plan',
		'  --allow-official-sdk-placeholder  Use official-swift-wasm-sdk when no SDK archive is found',
		'  --json                            Print the full discovery object as JSON'
	].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		const options = parseDiscoverBuildOutputsArgs(process.argv.slice(2));
		if (options.help) {
			console.log(usage());
		} else {
			const discovery = await discoverSwiftBrowserBuildOutputs(options);
			if (options.writePlan) {
				await writeDiscoveredOutputsToPlan({ planPath: options.planPath, discovery });
			}
			console.log(options.json ? JSON.stringify(discovery, null, 2) : formatDiscovery(discovery));
			if (!discovery.ready) {
				process.exitCode = 1;
			}
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
