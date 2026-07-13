#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { prepareSwiftRawRuntime } from './prepare-raw-runtime.mjs';
import { createSwiftRuntimeContract } from './runtime-contract.mjs';
import {
	discoverSwiftBrowserBuildOutputs,
	writeDiscoveredOutputsToPlan
} from './discover-build-outputs.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const RUNTIME_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const DEFAULT_BUILD_DIR = path.join(RUNTIME_ROOT, 'browser-compiler-build');
const DEFAULT_RAW_RUNTIME_DIR = path.join(RUNTIME_ROOT, 'raw-runtime');
const DEFAULT_PLAN_NAME = 'wasm-idle-swift-browser-build-plan.json';
const DEFAULT_REQUIRED_TOOLS = ['python3', 'cmake', 'ninja'];
const SOURCE_BOOTSTRAP_RECEIPT_FORMAT = 'wasm-idle-swift-source-bootstrap-receipt-v1';
const UPSTREAM_WASM_BASELINE_PRESETS = [
	'buildbot_linux_crosscompile_wasm',
	'wasm_stdlib',
	'wasm_stdlib_incremental'
];
const BASELINE_PRESET_SET = new Set(UPSTREAM_WASM_BASELINE_PRESETS);
const BROWSER_COMPILER_OUTPUT_CONTRACTS = [
	{
		name: 'runner-worker.js',
		description: 'Browser worker that accepts wasm-idle Swift run messages and loads swiftc.wasm, swiftpm.wasm, and sdk.tar.gz from the runtime base URL.',
		validation: 'validateSwiftRunnerWorkerSource'
	},
	{
		name: 'swiftc.wasm',
		description: 'Browser-loadable Swift compiler WebAssembly module, not a native host binary and not a placeholder module.',
		requiredIdentity: ['swift', 'swiftc'],
		validation: 'validateSwiftCompilerWasmModuleBytes'
	},
	{
		name: 'swiftpm.wasm',
		description: 'Browser-loadable SwiftPM WebAssembly module used by the runner for package/workspace builds.',
		requiredIdentity: ['swiftpm', 'SwiftPM', 'Swift Package'],
		validation: 'validateSwiftCompilerWasmModuleBytes'
	},
	{
		name: 'sdk.tar.gz',
		description: 'Gzip-compressed Swift Wasm SDK archive consumed by the browser compiler runtime.',
		validation: 'validateSwiftSdkArchiveBytes'
	}
];

const CHECKOUT_REQUIRED_FILES = [
	['swift', 'utils', 'build-script'],
	['swift', 'CMakeLists.txt'],
	['llvm-project', 'llvm', 'CMakeLists.txt'],
	['swiftpm', 'Package.swift']
];

const INPUT_FILE_OPTIONS = {
	'--runner-worker': 'runner-worker.js',
	'--swiftc-wasm': 'swiftc.wasm',
	'--swiftpm-wasm': 'swiftpm.wasm',
	'--sdk-archive': 'sdk.tar.gz'
};

export function classifySwiftBrowserBuildCommand(command) {
	if (typeof command !== 'string' || !command.trim()) {
		return { ok: true };
	}
	const normalized = command.trim();
	if (/^(?::|true|false|echo(?:\s+.*)?|printf(?:\s+.*)?)$/u.test(normalized)) {
		return {
			ok: false,
			error:
				'browser build command must run the build or promotion step that creates runner-worker.js, swiftc.wasm, and swiftpm.wasm; no-op/documentation commands are not accepted.'
		};
	}
	const match =
		/^(?:(?:\.\/)?swift\/utils\/build-script|(?:\.\/)?utils\/build-script|[^ \t]+\/swift\/utils\/build-script)\s+--preset\s+([A-Za-z0-9_+-]+)\s*$/u.exec(
			normalized
		);
	if (match && BASELINE_PRESET_SET.has(match[1])) {
		return {
			ok: false,
			preset: match[1],
			error:
				`${match[1]} is a native Swift/WASI baseline preset, not a browser compiler build command. ` +
				'Use it through run:wasm-swift-upstream-baseline and provide the command that actually creates runner-worker.js, swiftc.wasm, and swiftpm.wasm.'
		};
	}
	return { ok: true };
}

async function pathExists(filePath) {
	return !!(await stat(filePath).catch(() => null));
}

function readOptionValue(argv, index, optionName) {
	const value = argv[index + 1];
	if (typeof value !== 'string' || !value || value.startsWith('--')) {
		throw new Error(`${optionName} requires a value`);
	}
	return value;
}

function runToolVersion(command) {
	return new Promise((resolve) => {
		const child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk;
		});
		child.on('error', (error) => {
			resolve({ tool: command, ok: false, error: error.message });
		});
		child.on('close', (code) => {
			resolve({
				tool: command,
				ok: code === 0,
				version: `${stdout}${stderr}`.split('\n')[0]?.trim() || null,
				...(code === 0 ? {} : { error: `${command} --version exited with ${code}` })
			});
		});
	});
}

export function parseBuildBrowserCompilerArgs(argv) {
	const options = {
		checkoutRoot: null,
		buildDir: DEFAULT_BUILD_DIR,
		rawRuntimeDir: DEFAULT_RAW_RUNTIME_DIR,
		planPath: null,
		sourceBootstrapReceipt: null,
		requiredTools: [...DEFAULT_REQUIRED_TOOLS],
		allowMissingTools: false,
		prepareRawRuntime: false,
		fetchOfficialSdk: false,
		browserBuildCommand: null,
		browserBuildLog: null,
		executeBrowserBuildCommand: false,
		discoverBuildOutputs: false,
		inputs: {}
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--') {
			continue;
		} else if (arg === '--help') {
			return { help: true };
		} else if (arg === '--checkout-root') {
			options.checkoutRoot = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--build-dir') {
			options.buildDir = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--raw-runtime-dir') {
			options.rawRuntimeDir = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--plan-path') {
			options.planPath = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--source-bootstrap-receipt') {
			options.sourceBootstrapReceipt = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--require-tool') {
			options.requiredTools.push(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--allow-missing-tools') {
			options.allowMissingTools = true;
		} else if (arg === '--prepare-raw-runtime') {
			options.prepareRawRuntime = true;
		} else if (arg === '--fetch-official-sdk') {
			options.fetchOfficialSdk = true;
		} else if (arg === '--browser-build-command') {
			options.browserBuildCommand = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--browser-build-log') {
			options.browserBuildLog = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--execute-browser-build-command') {
			options.executeBrowserBuildCommand = true;
		} else if (arg === '--discover-build-outputs') {
			options.discoverBuildOutputs = true;
		} else if (Object.hasOwn(INPUT_FILE_OPTIONS, arg)) {
			options.inputs[INPUT_FILE_OPTIONS[arg]] = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

async function readJsonFile(filePath, label) {
	const normalizedPath = path.resolve(filePath);
	const text = await readFile(normalizedPath, 'utf8').catch((error) => {
		throw new Error(`${label} could not be read from ${normalizedPath}: ${error instanceof Error ? error.message : String(error)}`);
	});
	try {
		return { filePath: normalizedPath, value: JSON.parse(text) };
	} catch (error) {
		throw new Error(`${label} could not be parsed from ${normalizedPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function validateSourceBootstrapReceipt(receiptPath, checkoutRoot) {
	const normalizedCheckoutRoot = path.resolve(checkoutRoot);
	const { filePath, value: receipt } = await readJsonFile(receiptPath, 'source bootstrap receipt');
	if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
		throw new Error('source bootstrap receipt must be a JSON object');
	}
	if (receipt.format !== SOURCE_BOOTSTRAP_RECEIPT_FORMAT) {
		throw new Error(`source bootstrap receipt format is invalid: ${receipt.format ?? 'missing'}`);
	}
	if (receipt.status !== 'passed') {
		throw new Error(`source bootstrap receipt status must be passed before build planning: ${receipt.status ?? 'missing'}`);
	}
	if (path.resolve(receipt.sourceRoot ?? '') !== normalizedCheckoutRoot) {
		throw new Error(
			`source bootstrap receipt sourceRoot ${receipt.sourceRoot ?? 'missing'} does not match checkout root ${normalizedCheckoutRoot}`
		);
	}
	if (!receipt.checkout || typeof receipt.checkout !== 'object' || receipt.checkout.ok !== true) {
		throw new Error('source bootstrap receipt checkout verification must be present and passing');
	}
	return {
		path: filePath,
		format: receipt.format,
		status: receipt.status,
		sourceRoot: normalizedCheckoutRoot,
		swiftRepository: receipt.swiftRepository ?? null,
		swiftRef: receipt.swiftRef ?? null,
		swiftCloneDepth: receipt.swiftCloneDepth ?? null,
		swiftCloneFilter: receipt.swiftCloneFilter ?? null,
		dependencyScheme: receipt.dependencyScheme ?? null,
		startedAt: receipt.startedAt ?? null,
		finishedAt: receipt.finishedAt ?? null,
		checkout: receipt.checkout
	};
}

export async function inspectSwiftSourceCheckout(checkoutRoot) {
	if (typeof checkoutRoot !== 'string' || !checkoutRoot.trim()) {
		throw new Error('checkoutRoot is required');
	}
	const normalizedCheckoutRoot = path.resolve(checkoutRoot);
	const missing = [];
	for (const segments of CHECKOUT_REQUIRED_FILES) {
		const relativePath = path.join(...segments);
		if (!(await pathExists(path.join(normalizedCheckoutRoot, relativePath)))) {
			missing.push(relativePath);
		}
	}
	return {
		checkoutRoot: normalizedCheckoutRoot,
		ok: missing.length === 0,
		missing
	};
}

export async function inspectBuildTools(requiredTools, runTool = runToolVersion) {
	const results = [];
	for (const tool of requiredTools) {
		if (typeof tool !== 'string' || !tool.trim()) {
			throw new Error('requiredTools must contain non-empty command names');
		}
		results.push(await runTool(tool));
	}
	return results;
}

export async function createSwiftBrowserCompilerBuildPlan({
	checkoutRoot,
	buildDir = DEFAULT_BUILD_DIR,
	rawRuntimeDir = DEFAULT_RAW_RUNTIME_DIR,
	planPath,
	sourceBootstrapReceipt = null,
	requiredTools = DEFAULT_REQUIRED_TOOLS,
	allowMissingTools = false,
	inputs = {},
	fetchOfficialSdk = false,
	browserBuildCommand = null,
	runTool = runToolVersion
} = {}) {
	const checkout = await inspectSwiftSourceCheckout(checkoutRoot);
	if (!checkout.ok) {
		throw new Error(
			`Swift source checkout is incomplete in ${checkout.checkoutRoot}: missing ${checkout.missing.join(', ')}`
		);
	}
	const sourceBootstrap =
		sourceBootstrapReceipt === null
			? null
			: await validateSourceBootstrapReceipt(sourceBootstrapReceipt, checkout.checkoutRoot);
	const browserBuildCommandClassification = classifySwiftBrowserBuildCommand(browserBuildCommand);
	if (!browserBuildCommandClassification.ok) {
		throw new Error(browserBuildCommandClassification.error);
	}
	const tools = await inspectBuildTools(requiredTools, runTool);
	const missingTools = tools.filter((tool) => !tool.ok).map((tool) => tool.tool);
	if (missingTools.length > 0 && !allowMissingTools) {
		throw new Error(`Swift browser compiler build tools are missing: ${missingTools.join(', ')}`);
	}
	const normalizedBuildDir = path.resolve(buildDir);
	const normalizedRawRuntimeDir = path.resolve(rawRuntimeDir);
	const normalizedPlanPath = path.resolve(planPath ?? path.join(normalizedBuildDir, DEFAULT_PLAN_NAME));
	const plan = {
		format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
		checkoutRoot: checkout.checkoutRoot,
		sourceBootstrap,
		buildDir: normalizedBuildDir,
		rawRuntimeDir: normalizedRawRuntimeDir,
		requiredTools: tools,
		upstreamWasmBaseline: {
			presets: UPSTREAM_WASM_BASELINE_PRESETS,
			commands: UPSTREAM_WASM_BASELINE_PRESETS.map((preset) => [
				path.join(checkout.checkoutRoot, 'swift', 'utils', 'build-script'),
				'--preset',
				preset
			]),
			note: 'These upstream presets validate the native Swift/WASI baseline and WASI stdlib path. They are not treated as proof that swiftc.wasm or swiftpm.wasm were produced for browser execution.'
		},
		browserCompilerBuild: {
			command:
				typeof browserBuildCommand === 'string' && browserBuildCommand.trim()
					? browserBuildCommand
					: null,
			requiredOutputs: BROWSER_COMPILER_OUTPUT_CONTRACTS.map((contract) => ({
				...contract,
				expectedPath:
					inputs[contract.name] ??
					(contract.name === 'sdk.tar.gz' && fetchOfficialSdk
						? 'official-swift-wasm-sdk'
						: path.join(normalizedBuildDir, contract.name))
			})),
			runtimeContract: createSwiftRuntimeContract(),
			note: 'Package and readiness steps accept only these browser runtime outputs after contract validation. Native SwiftWasm SDK artifactbundles are SDK inputs, not browser compiler outputs.'
		},
		expectedOutputs: {
			'runner-worker.js': inputs['runner-worker.js'] ?? path.join(normalizedBuildDir, 'runner-worker.js'),
			'swiftc.wasm': inputs['swiftc.wasm'] ?? path.join(normalizedBuildDir, 'swiftc.wasm'),
			'swiftpm.wasm': inputs['swiftpm.wasm'] ?? path.join(normalizedBuildDir, 'swiftpm.wasm'),
			'sdk.tar.gz': inputs['sdk.tar.gz'] ?? (fetchOfficialSdk ? 'official-swift-wasm-sdk' : null)
		},
		nextCommands: [
			`${path.join(checkout.checkoutRoot, 'swift', 'utils', 'build-script')} --preset buildbot_linux_crosscompile_wasm`,
			`pnpm run run:wasm-swift-upstream-baseline -- --plan ${normalizedPlanPath} --preset buildbot_linux_crosscompile_wasm`,
			`pnpm run discover:wasm-swift-build-outputs -- --build-dir ${normalizedBuildDir} --plan ${normalizedPlanPath} --allow-official-sdk-placeholder --write-plan`,
			`pnpm --dir runtime/swift run prepare:raw-runtime -- --source-dir ${normalizedRawRuntimeDir} --runner-worker <runner-worker.js> --swiftc-wasm <swiftc.wasm> --swiftpm-wasm <swiftpm.wasm> ${fetchOfficialSdk ? '--fetch-official-sdk' : '--sdk-archive <sdk.tar.gz>'}`,
			`pnpm run package-sync:wasm-swift-from-plan:strict -- --plan ${normalizedPlanPath} --swift-version <version> --wasm-sdk-id <sdk-id> --source "<build provenance>"`,
			'pnpm run doctor:wasm-swift:candidate',
			'pnpm run verify:wasm-swift-candidate',
			'pnpm run doctor:wasm-swift:strict',
			'pnpm run verify:wasm-swift-readiness'
		]
	};
	await mkdir(path.dirname(normalizedPlanPath), { recursive: true });
	await writeFile(normalizedPlanPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
	return { planPath: normalizedPlanPath, plan };
}

export async function runSwiftBrowserCompilerBuildHarness({
	prepareRawRuntime = false,
	executeBrowserBuildCommand = false,
	discoverBuildOutputs = false,
	browserBuildCommandRunner = null,
	...options
} = {}) {
	let result = await createSwiftBrowserCompilerBuildPlan(options);
	if (executeBrowserBuildCommand) {
		const command = result.plan.browserCompilerBuild.command;
		if (typeof command !== 'string' || !command.trim()) {
			throw new Error('--execute-browser-build-command requires --browser-build-command');
		}
		const env = {
			...process.env,
			WASM_SWIFT_BUILD_DIR: result.plan.buildDir,
			WASM_SWIFT_RAW_RUNTIME_DIR: result.plan.rawRuntimeDir,
			WASM_SWIFT_PLAN_PATH: result.planPath
		};
		const runCommand =
			browserBuildCommandRunner ??
			((commandToRun, spawnOptions) =>
				new Promise((resolve, reject) => {
					let logStream = null;
					if (typeof spawnOptions.logPath === 'string' && spawnOptions.logPath.trim()) {
						logStream = createWriteStream(spawnOptions.logPath, { flags: 'a' });
						logStream.write(
							`$ ${commandToRun}\n# cwd: ${spawnOptions.cwd}\n# startedAt: ${startedAt}\n`
						);
					}
					const child = spawn(commandToRun, {
						cwd: spawnOptions.cwd,
						env: spawnOptions.env,
						shell: true,
						stdio: ['ignore', logStream ? 'pipe' : 'inherit', logStream ? 'pipe' : 'inherit']
					});
					if (logStream) {
						child.stdout?.on('data', (chunk) => {
							process.stdout.write(chunk);
							logStream.write(chunk);
						});
						child.stderr?.on('data', (chunk) => {
							process.stderr.write(chunk);
							logStream.write(chunk);
						});
					}
					const finishLog = (line) => {
						if (!logStream) return;
						logStream.end(`${line}\n`);
					};
					child.on('error', reject);
					child.on('close', (code) => {
						if (code === 0) {
							finishLog(`# finishedAt: ${new Date().toISOString()}\n# exitCode: ${code}`);
							resolve({ code });
						} else {
							finishLog(`# finishedAt: ${new Date().toISOString()}\n# exitCode: ${code}`);
							reject(new Error(`Swift browser build command exited with ${code}`));
						}
					});
				}));
		const startedAt = new Date().toISOString();
		if (typeof options.browserBuildLog === 'string' && options.browserBuildLog.trim()) {
			await mkdir(path.dirname(options.browserBuildLog), { recursive: true });
		}
		const spawnOptions = {
			cwd: result.plan.checkoutRoot,
			env,
			buildDir: result.plan.buildDir,
			rawRuntimeDir: result.plan.rawRuntimeDir,
			planPath: result.planPath,
			logPath: options.browserBuildLog
		};
		try {
			const commandResult = (await runCommand(command, spawnOptions)) ?? {};
			result.plan.browserCompilerBuild.execution = {
				status: 'passed',
				command,
				cwd: result.plan.checkoutRoot,
				buildDir: result.plan.buildDir,
				rawRuntimeDir: result.plan.rawRuntimeDir,
				planPath: result.planPath,
				logPath: options.browserBuildLog ?? null,
				startedAt,
				finishedAt: new Date().toISOString(),
				exitCode: Number.isInteger(commandResult.code) ? commandResult.code : 0
			};
			await writeFile(result.planPath, `${JSON.stringify(result.plan, null, 2)}\n`, 'utf8');
		} catch (error) {
			result.plan.browserCompilerBuild.execution = {
				status: 'failed',
				command,
				cwd: result.plan.checkoutRoot,
				buildDir: result.plan.buildDir,
				rawRuntimeDir: result.plan.rawRuntimeDir,
				planPath: result.planPath,
				logPath: options.browserBuildLog ?? null,
				startedAt,
				finishedAt: new Date().toISOString(),
				error: error instanceof Error ? error.message : String(error)
			};
			await writeFile(result.planPath, `${JSON.stringify(result.plan, null, 2)}\n`, 'utf8');
			throw error;
		}
	}
	if (discoverBuildOutputs) {
		const discovery = await discoverSwiftBrowserBuildOutputs({
			buildDir: result.plan.buildDir,
			allowOfficialSdkPlaceholder: result.plan.expectedOutputs['sdk.tar.gz'] === 'official-swift-wasm-sdk'
		});
		const updated = await writeDiscoveredOutputsToPlan({
			planPath: result.planPath,
			discovery
		});
		result = { ...updated, discovery };
		if (!discovery.ready) {
			throw new Error(
				`Swift browser compiler build outputs are incomplete: ${discovery.missing.join(', ')}`
			);
		}
	}
	if (prepareRawRuntime) {
		await prepareSwiftRawRuntime({
			sourceDir: result.plan.rawRuntimeDir,
			inputs: Object.fromEntries(
				Object.entries(result.plan.expectedOutputs).filter(([, value]) => typeof value === 'string' && value !== 'official-swift-wasm-sdk')
			),
			fetchOfficialSdk: result.plan.expectedOutputs['sdk.tar.gz'] === 'official-swift-wasm-sdk'
		});
	}
	return result;
}

function usage() {
	return [
		'Usage: pnpm --dir runtime/swift run build:browser-compiler -- --checkout-root path/to/swift-source-root [options]',
		'',
		'Validates a Swift monorepo checkout and local build tools, then writes a build plan',
		'that maps browser compiler outputs into prepare:raw-runtime.',
		'',
		'Options:',
		'  --checkout-root <dir>       Swift source checkout root containing swift/, llvm-project/, swiftpm/',
		'  --build-dir <dir>           Directory where browser compiler outputs are expected',
		'  --raw-runtime-dir <dir>     Raw runtime directory consumed by package:wasm-swift',
		'  --plan-path <file>          Build plan JSON output path',
		'  --source-bootstrap-receipt <file>',
		'                              Validate and record bootstrap:source --receipt provenance',
		'  --require-tool <command>    Additional build tool to probe with --version',
		'  --allow-missing-tools       Write the plan even when tool probes fail',
		'  --browser-build-command <command>',
		'                              Record the command that produces browser compiler outputs',
		'  --browser-build-log <file>  Tee browser build command stdout/stderr into this log file',
		'  --execute-browser-build-command',
		'                              Run --browser-build-command in the checkout after writing the plan',
		'  --discover-build-outputs    Validate build outputs and write discovered paths into the plan',
		'  --runner-worker <file>      Existing runner worker output path',
		'  --swiftc-wasm <file>        Existing or expected swiftc.wasm output path',
		'  --swiftpm-wasm <file>       Existing or expected swiftpm.wasm output path',
		'  --sdk-archive <file>        Existing SDK archive output path',
		'  --fetch-official-sdk        Use the documented Swift.org SDK artifact for sdk.tar.gz',
		'  --prepare-raw-runtime       Immediately run prepare:raw-runtime from the mapped outputs',
		'',
		'This harness does not pretend that upstream Swift already ships browser swiftc.wasm.',
		'It records and validates the source/build environment needed for that direct build path.'
	].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		const options = parseBuildBrowserCompilerArgs(process.argv.slice(2));
		if (options.help) {
			console.log(usage());
		} else {
			const result = await runSwiftBrowserCompilerBuildHarness(options);
			console.log(`Wrote Swift browser compiler build plan: ${result.planPath}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
