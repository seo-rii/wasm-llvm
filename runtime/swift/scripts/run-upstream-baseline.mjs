#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import {
	DEFAULT_MIN_SWIFT_BUILD_FREE_GIB,
	formatGiB,
	inspectFreeDiskSpace
} from './disk-space.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const RUNTIME_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const DEFAULT_PLAN_PATH = path.join(
	RUNTIME_ROOT,
	'browser-compiler-build',
	'wasm-idle-swift-browser-build-plan.json'
);
const BUILD_PLAN_FORMAT = 'wasm-idle-swift-browser-compiler-build-plan-v1';
const DEFAULT_PRESET = 'buildbot_linux_crosscompile_wasm';
const PRESET_SUBSTITUTION_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.+$/u;

function readOptionValue(argv, index, optionName) {
	const value = argv[index + 1];
	if (typeof value !== 'string' || !value || value.startsWith('--')) {
		throw new Error(`${optionName} requires a value`);
	}
	return value;
}

function runCommand(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: 'inherit'
		});
		child.on('error', reject);
		child.on('close', (code, signal) => {
			if (code === 0) {
				resolve({ exitCode: code, signal: null });
				return;
			}
			const reason = signal ? `signal ${signal}` : `code ${code}`;
			const error = new Error(`${command} ${args.join(' ')} failed with ${reason}`);
			error.exitCode = code;
			error.signal = signal;
			reject(error);
		});
	});
}

export function parseRunUpstreamBaselineArgs(argv) {
	const options = {
		planPath: DEFAULT_PLAN_PATH,
		preset: DEFAULT_PRESET,
		receiptPath: null,
		dryRun: false,
		writePlan: true,
		allowInsufficientDisk: false,
		minFreeGiB: DEFAULT_MIN_SWIFT_BUILD_FREE_GIB,
		presetSubstitutions: [],
		presetFiles: [],
		allowUnplannedPreset: false
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
		} else if (arg === '--preset') {
			options.preset = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--receipt') {
			options.receiptPath = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--dry-run') {
			options.dryRun = true;
		} else if (arg === '--preset-substitution') {
			const value = readOptionValue(argv, index, arg);
			if (!PRESET_SUBSTITUTION_PATTERN.test(value)) {
				throw new Error('--preset-substitution must be formatted as name=value');
			}
			options.presetSubstitutions.push(value);
			index += 1;
		} else if (arg === '--preset-file') {
			options.presetFiles.push(path.resolve(readOptionValue(argv, index, arg)));
			index += 1;
		} else if (arg === '--allow-unplanned-preset') {
			options.allowUnplannedPreset = true;
		} else if (arg === '--no-write-plan') {
			options.writePlan = false;
		} else if (arg === '--allow-insufficient-disk') {
			options.allowInsufficientDisk = true;
		} else if (arg === '--min-free-gib') {
			const value = Number(readOptionValue(argv, index, arg));
			if (!Number.isFinite(value) || value < 0) {
				throw new Error('--min-free-gib must be a non-negative number');
			}
			options.minFreeGiB = value;
			index += 1;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

function defaultPresetSubstitutions(plan, preset) {
	const outputRoot = path.join(plan.buildDir, `upstream-baseline-${preset}`);
	return [
		`install_destdir=${path.join(outputRoot, 'install')}`,
		`installable_package=${path.join(outputRoot, `${preset}.tar.gz`)}`
	];
}

export function selectSwiftUpstreamBaselineCommand(
	plan,
	preset = DEFAULT_PRESET,
	{ presetFiles = [], allowUnplannedPreset = false } = {}
) {
	if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
		throw new Error('Swift browser build plan must be an object');
	}
	if (plan.format !== BUILD_PLAN_FORMAT) {
		throw new Error(`Swift browser build plan format must be ${BUILD_PLAN_FORMAT}`);
	}
	if (typeof plan.buildDir !== 'string' || !path.isAbsolute(plan.buildDir)) {
		throw new Error('Swift browser build plan buildDir must be an absolute path');
	}
	if (typeof plan.checkoutRoot !== 'string' || !path.isAbsolute(plan.checkoutRoot)) {
		throw new Error('Swift browser build plan checkoutRoot must be an absolute path');
	}
	const presets = plan.upstreamWasmBaseline?.presets;
	const commands = plan.upstreamWasmBaseline?.commands;
	if (!Array.isArray(presets) || !Array.isArray(commands)) {
		throw new Error('Swift browser build plan is missing upstreamWasmBaseline presets and commands');
	}
	const presetIndex = presets.indexOf(preset);
	if (presetIndex < 0) {
		if (!allowUnplannedPreset) {
			throw new Error(`Swift upstream Wasm baseline preset was not found in the build plan: ${preset}`);
		}
		const baseCommand = commands.find((candidate) => Array.isArray(candidate) && candidate.length > 0);
		if (!baseCommand) {
			throw new Error('Swift browser build plan does not contain a build-script command');
		}
		return [
			baseCommand[0],
			...presetFiles.flatMap((presetFile) => ['--preset-file', presetFile]),
			'--preset',
			preset
		];
	}
	const command = commands[presetIndex];
	if (
		!Array.isArray(command) ||
		command.length === 0 ||
		command.some((part) => typeof part !== 'string' || !part)
	) {
		throw new Error(`Swift upstream Wasm baseline command is invalid for preset: ${preset}`);
	}
	return [
		command[0],
		...presetFiles.flatMap((presetFile) => ['--preset-file', presetFile]),
		...command.slice(1)
	];
}

export async function runSwiftUpstreamBaselineBuild({
	planPath = DEFAULT_PLAN_PATH,
	preset = DEFAULT_PRESET,
	receiptPath,
	dryRun = false,
	writePlan = true,
	allowInsufficientDisk = false,
	minFreeGiB = DEFAULT_MIN_SWIFT_BUILD_FREE_GIB,
	presetSubstitutions = [],
	presetFiles = [],
	allowUnplannedPreset = false,
	inspectDiskSpace = inspectFreeDiskSpace,
	run = runCommand
} = {}) {
	const normalizedPlanPath = path.resolve(planPath);
	const plan = JSON.parse(await readFile(normalizedPlanPath, 'utf8'));
	const normalizedPresetFiles = presetFiles.map((presetFile) => path.resolve(presetFile));
	const command = selectSwiftUpstreamBaselineCommand(plan, preset, {
		presetFiles: normalizedPresetFiles,
		allowUnplannedPreset
	});
	const normalizedReceiptPath = path.resolve(
		receiptPath ?? path.join(plan.buildDir, `wasm-idle-swift-upstream-baseline-${preset}.json`)
	);
	const startedAt = new Date().toISOString();
	let status = 'dry-run';
	let exitCode = null;
	let terminationSignal = null;
	let errorMessage = null;
	const commandWithSubstitutions = [
		...command,
		...defaultPresetSubstitutions(plan, preset),
		...presetSubstitutions
	];
	if (!dryRun) {
		const disk = await inspectDiskSpace(plan.buildDir, { minFreeGiB });
		if (!disk.ok && !allowInsufficientDisk) {
			throw new Error(
				`Swift upstream baseline build requires at least ${disk.minFreeGiB} GiB free under ${disk.probePath}; ` +
					`found ${formatGiB(disk.freeBytes)} GiB. ` +
					'Pass --allow-insufficient-disk only when using an external workspace with enough capacity.'
			);
		}
		try {
			const result = await run(commandWithSubstitutions[0], commandWithSubstitutions.slice(1), { cwd: plan.checkoutRoot });
			status = 'passed';
			exitCode = result?.exitCode ?? 0;
		} catch (error) {
			status = 'failed';
			exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : null;
			terminationSignal = typeof error?.signal === 'string' ? error.signal : null;
			errorMessage = error instanceof Error ? error.message : String(error);
		}
	}
	const receipt = {
		format: 'wasm-idle-swift-upstream-baseline-build-v1',
		planPath: normalizedPlanPath,
		preset,
		command: commandWithSubstitutions,
		cwd: plan.checkoutRoot,
		status,
		exitCode,
		terminationSignal,
		errorMessage,
		startedAt,
		finishedAt: new Date().toISOString(),
		note: 'This proves only the upstream Swift/WASI baseline preset execution. It is not evidence that browser swiftc.wasm or swiftpm.wasm outputs exist.'
	};
	await mkdir(path.dirname(normalizedReceiptPath), { recursive: true });
	const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
	await writeFile(normalizedReceiptPath, receiptBytes);
	const receiptDigest = createHash('sha256').update(receiptBytes).digest('hex');
	if (writePlan) {
		plan.upstreamWasmBaseline = {
			...plan.upstreamWasmBaseline,
			receipts: [
				...(Array.isArray(plan.upstreamWasmBaseline?.receipts)
					? plan.upstreamWasmBaseline.receipts.filter((entry) => entry?.preset !== preset)
					: []),
				{
					preset,
					path: normalizedReceiptPath,
					sha256: receiptDigest,
					status
				}
			]
		};
		await writeFile(normalizedPlanPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
	}
	if (status === 'failed') {
		throw new Error(`${commandWithSubstitutions[0]} ${commandWithSubstitutions.slice(1).join(' ')} failed`);
	}
	return { receiptPath: normalizedReceiptPath, receipt, receiptDigest, planUpdated: writePlan };
}

function usage() {
	return [
		'Usage: pnpm --dir runtime/swift run run:upstream-baseline -- [--plan path/to/plan.json]',
		'',
		'Runs one upstream Swift Wasm baseline preset recorded by build:browser-compiler and',
		'writes a receipt next to the browser compiler build plan.',
		'',
		'Options:',
		'  --plan <file>       Swift browser compiler build plan JSON',
		'  --preset <name>     Baseline preset to run from the plan',
		'  --receipt <file>    Receipt JSON output path',
		'  --dry-run           Write the receipt without executing the build command',
		'  --preset-substitution <name=value>',
		'                      Append a Swift build-script preset substitution',
		'  --preset-file <file>',
		'                      Pass an extra Swift build-script preset file',
		'  --allow-unplanned-preset',
		'                      Allow --preset to name a preset from --preset-file instead of the plan',
		'  --no-write-plan     Do not record the receipt path and sha256 back into the build plan',
		`  --min-free-gib <n>  Required free space before executing the build (default ${DEFAULT_MIN_SWIFT_BUILD_FREE_GIB})`,
		'  --allow-insufficient-disk',
		'                      Run even when the free-space preflight fails',
		'',
		'The receipt is a guardrail for the native Swift/WASI baseline only. It does not make',
		'Swift ready for wasm-idle until real browser swiftc.wasm and swiftpm.wasm outputs exist.'
	].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		const options = parseRunUpstreamBaselineArgs(process.argv.slice(2));
		if (options.help) {
			console.log(usage());
		} else {
			const result = await runSwiftUpstreamBaselineBuild(options);
			console.log(`Wrote Swift upstream baseline build receipt: ${result.receiptPath}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
