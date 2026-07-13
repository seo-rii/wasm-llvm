#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareSwiftRawRuntime } from './prepare-raw-runtime.mjs';
import {
	OFFICIAL_WASM_SDK_CHECKSUM,
	OFFICIAL_WASM_SDK_URL
} from './probe-toolchain.mjs';
import {
	validateSwiftCompilerWasmModuleBytes,
	validateSwiftRunnerWorkerSource,
	validateSwiftSdkArchiveBytes,
} from './runtime-manifest.mjs';
import { createSwiftRuntimeContract, validateSwiftRuntimeContract } from './runtime-contract.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const RUNTIME_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const DEFAULT_PLAN_PATH = path.join(
	RUNTIME_ROOT,
	'browser-compiler-build',
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

export function parseVerifyBuildOutputsArgs(argv) {
	const options = {
		planPath: DEFAULT_PLAN_PATH,
		allowOfficialSdkPlaceholder: false,
		prepareRawRuntime: false,
		requireBrowserCompilerContracts: false,
		requireBrowserBuildCommand: false,
		requireBrowserBuildExecution: false,
		requireBrowserBuildLog: false,
		requireSourceBootstrapProvenance: false,
		sdkUrl: OFFICIAL_WASM_SDK_URL,
		sdkChecksum: OFFICIAL_WASM_SDK_CHECKSUM
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
		} else if (arg === '--allow-official-sdk-placeholder') {
			options.allowOfficialSdkPlaceholder = true;
		} else if (arg === '--prepare-raw-runtime') {
			options.prepareRawRuntime = true;
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
		} else if (arg === '--sdk-url') {
			options.sdkUrl = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--sdk-checksum') {
			options.sdkChecksum = readOptionValue(argv, index, arg);
			index += 1;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

function validateBrowserCompilerBuildContracts(plan) {
	const errors = [];
	const requiredOutputs = plan.browserCompilerBuild?.requiredOutputs;
	if (!Array.isArray(requiredOutputs)) {
		return ['browserCompilerBuild.requiredOutputs must be an array'];
	}
	const contractsByName = new Map(requiredOutputs.map((output) => [output?.name, output]));
	const expectedValidations = {
		'runner-worker.js': 'validateSwiftRunnerWorkerSource',
		'swiftc.wasm': 'validateSwiftCompilerWasmModuleBytes',
		'swiftpm.wasm': 'validateSwiftCompilerWasmModuleBytes',
		'sdk.tar.gz': 'validateSwiftSdkArchiveBytes'
	};
	const expectedRequiredIdentities = {
		'swiftc.wasm': ['swift', 'swiftc'],
		'swiftpm.wasm': ['swiftpm', 'SwiftPM']
	};
	for (const [outputName, validation] of Object.entries(expectedValidations)) {
		const contract = contractsByName.get(outputName);
		if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
			errors.push(`browserCompilerBuild.requiredOutputs must include ${outputName}`);
			continue;
		}
		if (contract.validation !== validation) {
			errors.push(`browserCompilerBuild.requiredOutputs.${outputName}.validation must be ${validation}`);
		}
		const expectedPath = plan.expectedOutputs?.[outputName];
		if (contract.expectedPath !== expectedPath) {
			errors.push(`browserCompilerBuild.requiredOutputs.${outputName}.expectedPath must match expectedOutputs.${outputName}`);
		}
		const expectedIdentity = expectedRequiredIdentities[outputName];
		if (expectedIdentity) {
			if (!Array.isArray(contract.requiredIdentity)) {
				errors.push(`browserCompilerBuild.requiredOutputs.${outputName}.requiredIdentity must be an array`);
				continue;
			}
			for (const identity of expectedIdentity) {
				if (!contract.requiredIdentity.includes(identity)) {
					errors.push(
						`browserCompilerBuild.requiredOutputs.${outputName}.requiredIdentity must include ${identity}`
					);
				}
			}
		}
	}
	const runtimeContract = plan.browserCompilerBuild?.runtimeContract;
	const expectedRuntimeContract = createSwiftRuntimeContract();
	if (!runtimeContract || typeof runtimeContract !== 'object' || Array.isArray(runtimeContract)) {
		errors.push('browserCompilerBuild.runtimeContract must be an object');
	} else {
		const runtimeContractErrors = validateSwiftRuntimeContract(runtimeContract);
		if (runtimeContractErrors.length > 0) {
			errors.push(
				...runtimeContractErrors.map((error) => `browserCompilerBuild.runtimeContract ${error}`)
			);
		} else {
			const actualCaseNames = runtimeContract.cases.map((testCase) => testCase.name);
			const expectedCaseNames = expectedRuntimeContract.cases.map((testCase) => testCase.name);
			if (actualCaseNames.join('\n') !== expectedCaseNames.join('\n')) {
				errors.push(
					`browserCompilerBuild.runtimeContract.cases must exactly match ${expectedCaseNames.join(', ')}`
				);
			} else if (JSON.stringify(runtimeContract) !== JSON.stringify(expectedRuntimeContract)) {
				errors.push(
					'browserCompilerBuild.runtimeContract must match the current Swift browser runtime contract'
				);
			}
		}
	}
	return errors;
}

function validateSourceBootstrapProvenance(plan, { required = false } = {}) {
	const errors = [];
	const sourceBootstrap = plan.sourceBootstrap;
	if (sourceBootstrap === undefined || sourceBootstrap === null) {
		return required ? ['sourceBootstrap provenance is required'] : [];
	}
	if (!sourceBootstrap || typeof sourceBootstrap !== 'object' || Array.isArray(sourceBootstrap)) {
		return ['sourceBootstrap must be an object when provided'];
	}
	if (typeof sourceBootstrap.path !== 'string' || !path.isAbsolute(sourceBootstrap.path)) {
		errors.push('sourceBootstrap.path must be an absolute path');
	}
	if (sourceBootstrap.format !== 'wasm-idle-swift-source-bootstrap-receipt-v1') {
		errors.push('sourceBootstrap.format must be wasm-idle-swift-source-bootstrap-receipt-v1');
	}
	if (sourceBootstrap.status !== 'passed') {
		errors.push('sourceBootstrap.status must be passed');
	}
	if (typeof sourceBootstrap.sourceRoot !== 'string' || !path.isAbsolute(sourceBootstrap.sourceRoot)) {
		errors.push('sourceBootstrap.sourceRoot must be an absolute path');
	} else if (
		typeof plan.checkoutRoot === 'string' &&
		path.resolve(sourceBootstrap.sourceRoot) !== path.resolve(plan.checkoutRoot)
	) {
		errors.push('sourceBootstrap.sourceRoot must match checkoutRoot');
	}
	if (typeof sourceBootstrap.swiftRepository !== 'string' || !/^https:\/\/github\.com\/.+\/.+\.git$/u.test(sourceBootstrap.swiftRepository)) {
		errors.push('sourceBootstrap.swiftRepository must be an HTTPS GitHub clone URL ending in .git');
	}
	if (typeof sourceBootstrap.swiftRef !== 'string' || sourceBootstrap.swiftRef.trim().length === 0) {
		errors.push('sourceBootstrap.swiftRef must be a non-empty string');
	}
	if (
		sourceBootstrap.swiftCloneDepth !== null &&
		(!Number.isSafeInteger(sourceBootstrap.swiftCloneDepth) || sourceBootstrap.swiftCloneDepth <= 0)
	) {
		errors.push('sourceBootstrap.swiftCloneDepth must be null or a positive integer');
	}
	if (
		sourceBootstrap.swiftCloneFilter !== null &&
		(typeof sourceBootstrap.swiftCloneFilter !== 'string' ||
			!/^[A-Za-z0-9:._=-]+$/u.test(sourceBootstrap.swiftCloneFilter))
	) {
		errors.push('sourceBootstrap.swiftCloneFilter must be null or a git clone filter expression');
	}
	if (typeof sourceBootstrap.dependencyScheme !== 'string' || sourceBootstrap.dependencyScheme.trim().length === 0) {
		errors.push('sourceBootstrap.dependencyScheme must be a non-empty string');
	}
	for (const field of ['startedAt', 'finishedAt']) {
		if (typeof sourceBootstrap[field] !== 'string' || Number.isNaN(Date.parse(sourceBootstrap[field]))) {
			errors.push(`sourceBootstrap.${field} must be an ISO timestamp`);
		}
	}
	if (!sourceBootstrap.checkout || typeof sourceBootstrap.checkout !== 'object' || Array.isArray(sourceBootstrap.checkout)) {
		errors.push('sourceBootstrap.checkout must be an object');
	} else if (sourceBootstrap.checkout.ok !== true) {
		errors.push('sourceBootstrap.checkout.ok must be true');
	}
	return errors;
}

function validateBrowserBuildExecutionProvenance(plan, { required = false, requireLog = false } = {}) {
	const execution = plan.browserCompilerBuild?.execution;
	if (execution === undefined || execution === null) {
		return required ? ['browserCompilerBuild.execution provenance is required'] : [];
	}
	const errors = [];
	if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
		return ['browserCompilerBuild.execution must be an object when provided'];
	}
	if (execution.status !== 'passed') {
		errors.push('browserCompilerBuild.execution.status must be passed');
	}
	const command = plan.browserCompilerBuild?.command;
	if (typeof execution.command !== 'string' || execution.command.trim().length === 0) {
		errors.push('browserCompilerBuild.execution.command must be a non-empty string');
	} else if (typeof command === 'string' && command.trim() && execution.command !== command) {
		errors.push('browserCompilerBuild.execution.command must match browserCompilerBuild.command');
	}
	for (const field of ['cwd', 'buildDir', 'rawRuntimeDir', 'planPath']) {
		if (typeof execution[field] !== 'string' || !path.isAbsolute(execution[field])) {
			errors.push(`browserCompilerBuild.execution.${field} must be an absolute path`);
		}
	}
	if (
		typeof plan.checkoutRoot === 'string' &&
		path.isAbsolute(plan.checkoutRoot) &&
		typeof execution.cwd === 'string' &&
		path.resolve(execution.cwd) !== path.resolve(plan.checkoutRoot)
	) {
		errors.push('browserCompilerBuild.execution.cwd must match checkoutRoot');
	}
	if (
		typeof plan.buildDir === 'string' &&
		path.isAbsolute(plan.buildDir) &&
		typeof execution.buildDir === 'string' &&
		path.resolve(execution.buildDir) !== path.resolve(plan.buildDir)
	) {
		errors.push('browserCompilerBuild.execution.buildDir must match buildDir');
	}
	if (
		typeof plan.rawRuntimeDir === 'string' &&
		path.isAbsolute(plan.rawRuntimeDir) &&
		typeof execution.rawRuntimeDir === 'string' &&
		path.resolve(execution.rawRuntimeDir) !== path.resolve(plan.rawRuntimeDir)
	) {
		errors.push('browserCompilerBuild.execution.rawRuntimeDir must match rawRuntimeDir');
	}
	for (const field of ['startedAt', 'finishedAt']) {
		if (typeof execution[field] !== 'string' || Number.isNaN(Date.parse(execution[field]))) {
			errors.push(`browserCompilerBuild.execution.${field} must be an ISO timestamp`);
		}
	}
	if (
		typeof execution.startedAt === 'string' &&
		typeof execution.finishedAt === 'string' &&
		!Number.isNaN(Date.parse(execution.startedAt)) &&
		!Number.isNaN(Date.parse(execution.finishedAt)) &&
		Date.parse(execution.finishedAt) < Date.parse(execution.startedAt)
	) {
		errors.push('browserCompilerBuild.execution.finishedAt must not be before startedAt');
	}
	if (execution.exitCode !== 0) {
		errors.push('browserCompilerBuild.execution.exitCode must be 0');
	}
	if (execution.logPath !== undefined && execution.logPath !== null) {
		if (typeof execution.logPath !== 'string' || !path.isAbsolute(execution.logPath)) {
			errors.push('browserCompilerBuild.execution.logPath must be an absolute path when provided');
		}
	} else if (requireLog) {
		errors.push('browserCompilerBuild.execution.logPath is required');
	}
	return errors;
}

export function validateSwiftBrowserBuildPlan(
	plan,
	{
		requireBrowserCompilerContracts = false,
		requireBrowserBuildCommand = false,
		requireBrowserBuildExecution = false,
		requireBrowserBuildLog = false,
		requireSourceBootstrapProvenance = false
	} = {}
) {
	const errors = [];
	if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
		return ['build plan must be an object'];
	}
	if (plan.format !== BUILD_PLAN_FORMAT) {
		errors.push(`format must be ${BUILD_PLAN_FORMAT}`);
	}
	if (typeof plan.rawRuntimeDir !== 'string' || !path.isAbsolute(plan.rawRuntimeDir)) {
		errors.push('rawRuntimeDir must be an absolute path');
	}
	errors.push(...validateSourceBootstrapProvenance(plan, { required: requireSourceBootstrapProvenance }));
	if (!plan.expectedOutputs || typeof plan.expectedOutputs !== 'object' || Array.isArray(plan.expectedOutputs)) {
		errors.push('expectedOutputs must be an object');
		return errors;
	}
	for (const outputName of ['runner-worker.js', 'swiftc.wasm', 'swiftpm.wasm', 'sdk.tar.gz']) {
		if (!(outputName in plan.expectedOutputs)) {
			errors.push(`expectedOutputs.${outputName} is required`);
			continue;
		}
		const value = plan.expectedOutputs[outputName];
		if (outputName === 'sdk.tar.gz' && value === OFFICIAL_SDK_PLACEHOLDER) {
			continue;
		}
		if (typeof value !== 'string' || !path.isAbsolute(value)) {
			errors.push(`expectedOutputs.${outputName} must be an absolute file path`);
		}
	}
	if (requireBrowserCompilerContracts) {
		errors.push(...validateBrowserCompilerBuildContracts(plan));
	}
	if (requireBrowserBuildCommand) {
		const command = plan.browserCompilerBuild?.command;
		if (typeof command !== 'string' || command.trim().length === 0) {
			errors.push('browserCompilerBuild.command is required');
		}
	}
	errors.push(
		...validateBrowserBuildExecutionProvenance(plan, {
			required: requireBrowserBuildExecution || requireBrowserBuildLog,
			requireLog: requireBrowserBuildLog
		})
	);
	return errors;
}

export async function verifySwiftBrowserBuildOutputs({
	planPath = DEFAULT_PLAN_PATH,
	allowOfficialSdkPlaceholder = false,
	prepareRawRuntime = false,
	requireBrowserCompilerContracts = false,
	requireBrowserBuildCommand = false,
	requireBrowserBuildExecution = false,
	requireBrowserBuildLog = false,
	requireSourceBootstrapProvenance = false,
	sdkUrl = OFFICIAL_WASM_SDK_URL,
	sdkChecksum = OFFICIAL_WASM_SDK_CHECKSUM,
	fetchImpl = globalThis.fetch
} = {}) {
	const normalizedPlanPath = path.resolve(planPath);
	const plan = JSON.parse(await readFile(normalizedPlanPath, 'utf8'));
	const planErrors = validateSwiftBrowserBuildPlan(plan, {
		requireBrowserCompilerContracts,
		requireBrowserBuildCommand,
		requireBrowserBuildExecution,
		requireBrowserBuildLog,
		requireSourceBootstrapProvenance
	});
	if (planErrors.length > 0) {
		throw new Error(`Swift browser build plan is invalid:\n${planErrors.join('\n')}`);
	}
	const errors = [];
	const outputs = plan.expectedOutputs;
	const executionLogPath = plan.browserCompilerBuild?.execution?.logPath;
	if (requireBrowserBuildLog && typeof executionLogPath === 'string') {
		const logStats = await stat(executionLogPath).catch(() => null);
		if (!logStats?.isFile()) {
			errors.push(`browserCompilerBuild.execution.logPath file was not found: ${executionLogPath}`);
		}
	}
	for (const outputName of ['runner-worker.js', 'swiftc.wasm', 'swiftpm.wasm', 'sdk.tar.gz']) {
		const outputPath = outputs[outputName];
		if (outputPath === OFFICIAL_SDK_PLACEHOLDER) {
			if (!allowOfficialSdkPlaceholder) {
				errors.push(
					'sdk.tar.gz uses the official Swift SDK placeholder; pass --allow-official-sdk-placeholder or provide a concrete SDK archive path'
				);
			}
			continue;
		}
		const fileStats = await stat(outputPath).catch(() => null);
		if (!fileStats?.isFile()) {
			errors.push(`${outputName} was not found at ${outputPath}`);
			continue;
		}
		const bytes = await readFile(outputPath);
		if (outputName === 'runner-worker.js') {
			errors.push(...validateSwiftRunnerWorkerSource(bytes.toString('utf8')));
		} else if (outputName.endsWith('.wasm')) {
			errors.push(...(await validateSwiftCompilerWasmModuleBytes(bytes, outputName)));
		} else if (outputName === 'sdk.tar.gz') {
			errors.push(...validateSwiftSdkArchiveBytes(bytes, outputName));
		}
	}
	if (errors.length > 0) {
		throw new Error(`Swift browser build outputs are not ready:\n${errors.join('\n')}`);
	}
	if (prepareRawRuntime) {
		await prepareSwiftRawRuntime({
			sourceDir: plan.rawRuntimeDir,
			inputs: Object.fromEntries(
				Object.entries(outputs).filter(([, value]) => value !== OFFICIAL_SDK_PLACEHOLDER)
			),
			fetchOfficialSdk: outputs['sdk.tar.gz'] === OFFICIAL_SDK_PLACEHOLDER,
			sdkUrl,
			sdkChecksum,
			fetchImpl
		});
	}
	return {
		planPath: normalizedPlanPath,
		rawRuntimeDir: plan.rawRuntimeDir,
		outputs,
		officialSdkPlaceholder: outputs['sdk.tar.gz'] === OFFICIAL_SDK_PLACEHOLDER
	};
}

function usage() {
	return [
		'Usage: pnpm --dir runtime/swift run verify:build-outputs -- [--plan path/to/plan.json]',
		'',
		'Validates the browser compiler output paths recorded by build:browser-compiler.',
		'The verifier requires a real runner-worker.js, swiftc.wasm, and swiftpm.wasm.',
		'The official Swift SDK placeholder is accepted only with --allow-official-sdk-placeholder.',
		'Pass --prepare-raw-runtime to copy verified outputs into the plan rawRuntimeDir.',
		'Use --require-browser-compiler-contracts to require build plan output contracts.',
		'Use --require-browser-build-command to require browserCompilerBuild.command provenance.',
		'Use --require-browser-build-execution to require a passed browserCompilerBuild.execution receipt.',
		'Use --require-browser-build-log to require the execution receipt logPath file.',
		'Use --require-source-bootstrap-provenance to require sourceBootstrap receipt provenance.',
		'Use --sdk-url and --sdk-checksum only when the plan SDK placeholder should fetch another Swift.org SDK artifact.'
	].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		const options = parseVerifyBuildOutputsArgs(process.argv.slice(2));
		if (options.help) {
			console.log(usage());
		} else {
			const result = await verifySwiftBrowserBuildOutputs(options);
			console.log(`Swift browser build outputs are ready: ${result.planPath}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
