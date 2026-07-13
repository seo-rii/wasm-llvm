#!/usr/bin/env node
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
	DEFAULT_MIN_SWIFT_BUILD_FREE_GIB,
	formatGiB,
	inspectFreeDiskSpace
} from './disk-space.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const RUNTIME_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const DEFAULT_SOURCE_ROOT = path.join(RUNTIME_ROOT, 'source-checkout');
const DEFAULT_PLAN_NAME = 'wasm-idle-swift-source-bootstrap-plan.json';
const DEFAULT_SWIFT_REPOSITORY = 'https://github.com/swiftlang/swift.git';
const DEFAULT_SWIFT_REF = 'main';
const DEFAULT_DEPENDENCY_SCHEME = 'main';
const DEFAULT_REQUIRED_TOOLS = ['git', 'python3'];
const BOOTSTRAP_RECEIPT_FORMAT = 'wasm-idle-swift-source-bootstrap-receipt-v1';

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

function runCommand(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
		});
		let stdout = '';
		let stderr = '';
		if (options.capture) {
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdout.on('data', (chunk) => {
				stdout += chunk;
			});
			child.stderr.on('data', (chunk) => {
				stderr += chunk;
			});
		}
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			reject(new Error(`${command} ${args.join(' ')} failed with code ${code}\n${stderr}${stdout}`));
		});
	});
}

async function inspectTool(command, run = runCommand) {
	try {
		const result = await run(command, ['--version'], { capture: true });
		return {
			tool: command,
			ok: true,
			version: `${result.stdout}${result.stderr}`.split('\n')[0]?.trim() || null
		};
	} catch (error) {
		return { tool: command, ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

async function inspectExpectedCheckoutFiles(sourceRoot, expectedFiles) {
	const missing = [];
	for (const relativePath of expectedFiles) {
		if (!(await pathExists(path.join(sourceRoot, relativePath)))) {
			missing.push(relativePath);
		}
	}
	return {
		ok: missing.length === 0,
		missing,
		checked: expectedFiles
	};
}

export function parseBootstrapSourceCheckoutArgs(argv) {
	const options = {
		sourceRoot: DEFAULT_SOURCE_ROOT,
		planPath: null,
		swiftRepository: DEFAULT_SWIFT_REPOSITORY,
		swiftRef: DEFAULT_SWIFT_REF,
		swiftLocalBranch: null,
		swiftCloneDepth: null,
		swiftCloneFilter: null,
		dependencyScheme: DEFAULT_DEPENDENCY_SCHEME,
		receiptPath: null,
		requiredTools: [...DEFAULT_REQUIRED_TOOLS],
		allowExisting: false,
		allowMissingTools: false,
		allowInsufficientDisk: false,
		minFreeGiB: DEFAULT_MIN_SWIFT_BUILD_FREE_GIB,
		execute: false
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--') {
			continue;
		} else if (arg === '--help') {
			return { help: true };
		} else if (arg === '--source-root') {
			options.sourceRoot = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--plan-path') {
			options.planPath = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--swift-repository') {
			options.swiftRepository = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--swift-ref') {
			options.swiftRef = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--swift-local-branch') {
			options.swiftLocalBranch = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--swift-clone-depth') {
			const value = Number(readOptionValue(argv, index, arg));
			if (!Number.isSafeInteger(value) || value <= 0) {
				throw new Error('--swift-clone-depth must be a positive integer');
			}
			options.swiftCloneDepth = value;
			index += 1;
		} else if (arg === '--swift-clone-filter') {
			options.swiftCloneFilter = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--dependency-scheme') {
			options.dependencyScheme = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--receipt') {
			options.receiptPath = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--require-tool') {
			options.requiredTools.push(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--allow-existing') {
			options.allowExisting = true;
		} else if (arg === '--allow-missing-tools') {
			options.allowMissingTools = true;
		} else if (arg === '--allow-insufficient-disk') {
			options.allowInsufficientDisk = true;
		} else if (arg === '--min-free-gib') {
			const value = Number(readOptionValue(argv, index, arg));
			if (!Number.isFinite(value) || value < 0) {
				throw new Error('--min-free-gib must be a non-negative number');
			}
			options.minFreeGiB = value;
			index += 1;
		} else if (arg === '--execute') {
			options.execute = true;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

export const inspectBootstrapDiskSpace = inspectFreeDiskSpace;

export async function createSwiftSourceBootstrapPlan({
	sourceRoot = DEFAULT_SOURCE_ROOT,
	planPath,
	swiftRepository = DEFAULT_SWIFT_REPOSITORY,
	swiftRef = DEFAULT_SWIFT_REF,
	swiftLocalBranch = null,
	swiftCloneDepth = null,
	swiftCloneFilter = null,
	dependencyScheme = DEFAULT_DEPENDENCY_SCHEME,
	requiredTools = DEFAULT_REQUIRED_TOOLS,
	allowExisting = false,
	allowMissingTools = false,
	run = runCommand
} = {}) {
	if (typeof swiftRepository !== 'string' || !/^https:\/\/github\.com\/.+\/.+\.git$/u.test(swiftRepository)) {
		throw new Error('swiftRepository must be an HTTPS GitHub clone URL ending in .git');
	}
	if (typeof swiftRef !== 'string' || !swiftRef.trim()) {
		throw new Error('swiftRef is required');
	}
	if (
		swiftLocalBranch !== null &&
		(typeof swiftLocalBranch !== 'string' ||
			!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(swiftLocalBranch) ||
			swiftLocalBranch.includes('..') ||
			swiftLocalBranch.endsWith('/') ||
			swiftLocalBranch.endsWith('.lock'))
	) {
		throw new Error('swiftLocalBranch must be a safe git branch name when provided');
	}
	if (swiftCloneDepth !== null && (!Number.isSafeInteger(swiftCloneDepth) || swiftCloneDepth <= 0)) {
		throw new Error('swiftCloneDepth must be a positive integer when provided');
	}
	if (
		swiftCloneFilter !== null &&
		(typeof swiftCloneFilter !== 'string' || !/^[A-Za-z0-9:._=-]+$/u.test(swiftCloneFilter))
	) {
		throw new Error('swiftCloneFilter must be a non-empty git clone filter expression when provided');
	}
	if (typeof dependencyScheme !== 'string' || !dependencyScheme.trim()) {
		throw new Error('dependencyScheme is required');
	}
	const normalizedSourceRoot = path.resolve(sourceRoot);
	const swiftDir = path.join(normalizedSourceRoot, 'swift');
	if ((await pathExists(swiftDir)) && !allowExisting) {
		throw new Error(`Swift checkout already exists at ${swiftDir}; pass --allow-existing to reuse it`);
	}
	const tools = [];
	for (const tool of requiredTools) {
		if (typeof tool !== 'string' || !tool.trim()) {
			throw new Error('requiredTools must contain non-empty command names');
		}
		tools.push(await inspectTool(tool, run));
	}
	const missingTools = tools.filter((tool) => !tool.ok).map((tool) => tool.tool);
	if (missingTools.length > 0 && !allowMissingTools) {
		throw new Error(`Swift source bootstrap tools are missing: ${missingTools.join(', ')}`);
	}
	const normalizedPlanPath = path.resolve(planPath ?? path.join(normalizedSourceRoot, DEFAULT_PLAN_NAME));
	const cloneCommand = ['git', 'clone', '--branch', swiftRef];
	if (swiftCloneDepth !== null) {
		cloneCommand.push('--depth', String(swiftCloneDepth));
	}
	if (swiftCloneFilter !== null) {
		cloneCommand.push('--filter', swiftCloneFilter);
	}
	cloneCommand.push(swiftRepository, swiftDir);
	const updateCheckoutCommand = [
		path.join(swiftDir, 'utils', 'update-checkout'),
		'--clone',
		'--scheme',
		dependencyScheme
	];
	const createSwiftLocalBranchCommand =
		swiftLocalBranch === null ? null : ['git', 'checkout', '-B', swiftLocalBranch, 'HEAD'];
	const plan = {
		format: 'wasm-idle-swift-source-bootstrap-plan-v1',
		sourceRoot: normalizedSourceRoot,
		swiftRepository,
		swiftRef,
		swiftLocalBranch,
		swiftCloneDepth,
		swiftCloneFilter,
		dependencyScheme,
		requiredTools: tools,
		commands: {
			cloneSwift: cloneCommand,
			...(createSwiftLocalBranchCommand ? { createSwiftLocalBranch: createSwiftLocalBranchCommand } : {}),
			updateCheckout: updateCheckoutCommand
		},
		expectedCheckoutFiles: [
			path.join('swift', 'utils', 'build-script'),
			path.join('swift', 'CMakeLists.txt'),
			path.join('llvm-project', 'llvm', 'CMakeLists.txt'),
			path.join('swiftpm', 'Package.swift')
		],
		nextCommands: [
			`pnpm run build:wasm-swift-browser-compiler -- --checkout-root ${normalizedSourceRoot} --browser-build-command "<command that creates runner-worker.js swiftc.wasm swiftpm.wasm>" --allow-missing-tools`,
			'pnpm --dir runtime/swift run prepare:raw-runtime -- --source-dir <raw-runtime> --runner-worker <runner-worker.js> --swiftc-wasm <swiftc.wasm> --swiftpm-wasm <swiftpm.wasm> --fetch-official-sdk'
		]
	};
	await mkdir(path.dirname(normalizedPlanPath), { recursive: true });
	await writeFile(normalizedPlanPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
	return { planPath: normalizedPlanPath, plan };
}

function createBootstrapReceipt({ result, status, startedAt, finishedAt, error = null }) {
	return {
		format: BOOTSTRAP_RECEIPT_FORMAT,
		status,
		startedAt,
		finishedAt,
		sourceRoot: result.plan.sourceRoot,
		planPath: result.planPath,
		swiftRepository: result.plan.swiftRepository,
		swiftRef: result.plan.swiftRef,
		swiftLocalBranch: result.plan.swiftLocalBranch,
		swiftCloneDepth: result.plan.swiftCloneDepth,
		swiftCloneFilter: result.plan.swiftCloneFilter,
		dependencyScheme: result.plan.dependencyScheme,
		disk: result.disk ?? null,
		checkout: result.checkout ?? null,
		commands: result.plan.commands,
		expectedCheckoutFiles: result.plan.expectedCheckoutFiles,
		...(error ? { error } : {})
	};
}

async function writeBootstrapReceipt(receiptPath, receipt) {
	if (typeof receiptPath !== 'string' || !receiptPath.trim()) {
		throw new Error('receiptPath must be a non-empty path');
	}
	const normalizedReceiptPath = path.resolve(receiptPath);
	await mkdir(path.dirname(normalizedReceiptPath), { recursive: true });
	await writeFile(normalizedReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
	return normalizedReceiptPath;
}

export async function bootstrapSwiftSourceCheckout({
	execute = false,
	allowInsufficientDisk = false,
	minFreeGiB = DEFAULT_MIN_SWIFT_BUILD_FREE_GIB,
	inspectDiskSpace = inspectBootstrapDiskSpace,
	receiptPath = null,
	run = runCommand,
	...options
} = {}) {
	const result = await createSwiftSourceBootstrapPlan({ ...options, run });
	if (!execute) return result;
	const startedAt = new Date().toISOString();
	const sourceRoot = result.plan.sourceRoot;
	const disk = await inspectDiskSpace(sourceRoot, { minFreeGiB });
	result.disk = disk;
	try {
		if (!disk.ok && !allowInsufficientDisk) {
			throw new Error(
				`Swift source checkout execution requires at least ${disk.minFreeGiB} GiB free under ${disk.probePath}; ` +
					`found ${formatGiB(disk.freeBytes)} GiB. ` +
					'Pass --allow-insufficient-disk only when using an external workspace with enough capacity.'
			);
		}
		await mkdir(sourceRoot, { recursive: true });
		if (!(await pathExists(path.join(sourceRoot, 'swift')))) {
			await run('git', result.plan.commands.cloneSwift.slice(1));
		}
		if (result.plan.commands.createSwiftLocalBranch) {
			await run('git', result.plan.commands.createSwiftLocalBranch.slice(1), {
				cwd: path.join(sourceRoot, 'swift')
			});
		}
		await run(result.plan.commands.updateCheckout[0], result.plan.commands.updateCheckout.slice(1), {
			cwd: sourceRoot
		});
		result.checkout = await inspectExpectedCheckoutFiles(
			sourceRoot,
			result.plan.expectedCheckoutFiles
		);
		if (!result.checkout.ok) {
			throw new Error(
				`Swift source checkout is incomplete after bootstrap: missing ${result.checkout.missing.join(', ')}`
			);
		}
		const finishedAt = new Date().toISOString();
		result.receipt = createBootstrapReceipt({ result, status: 'passed', startedAt, finishedAt });
		if (receiptPath) {
			result.receiptPath = await writeBootstrapReceipt(receiptPath, result.receipt);
		}
	} catch (error) {
		const finishedAt = new Date().toISOString();
		result.receipt = createBootstrapReceipt({
			result,
			status: 'failed',
			startedAt,
			finishedAt,
			error: error instanceof Error ? error.message : String(error)
		});
		if (receiptPath) {
			result.receiptPath = await writeBootstrapReceipt(receiptPath, result.receipt);
		}
		throw error;
	}
	return result;
}

function usage() {
	return [
		'Usage: pnpm --dir runtime/swift run bootstrap:source -- [options]',
		'',
		'Writes a reproducible Swift source checkout bootstrap plan for direct browser compiler builds.',
		'Pass --execute only when you intentionally want to run the large git clone/update-checkout flow.',
		'',
		'Options:',
		'  --source-root <dir>         Directory that will contain swift/, llvm-project/, swiftpm/',
		'  --plan-path <file>          Bootstrap plan JSON output path',
		'  --swift-repository <url>    Swift repository clone URL',
		'  --swift-ref <ref>           Branch, tag, or commit for the swift clone',
		'  --swift-local-branch <ref>  Create/update this local branch at the cloned Swift HEAD before update-checkout',
		'  --swift-clone-depth <n>     Optional shallow clone depth for the initial swift.git clone',
		'  --swift-clone-filter <expr> Optional partial clone filter for the initial swift.git clone',
		'  --dependency-scheme <name>  update-checkout dependency scheme',
		'  --receipt <file>            Write execution receipt JSON when --execute is used',
		'  --require-tool <command>    Additional bootstrap tool to probe with --version',
		'  --allow-existing            Reuse an existing source-root/swift checkout',
		'  --allow-missing-tools       Write the plan even when local tool probes fail',
		`  --min-free-gib <gib>        Required free space before --execute (default ${DEFAULT_MIN_SWIFT_BUILD_FREE_GIB})`,
		'  --allow-insufficient-disk   Run --execute even when the free-space preflight fails',
		'  --execute                   Run git clone and swift/utils/update-checkout'
	].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		const options = parseBootstrapSourceCheckoutArgs(process.argv.slice(2));
		if (options.help) {
			console.log(usage());
		} else {
			const result = await bootstrapSwiftSourceCheckout(options);
			console.log(`Wrote Swift source bootstrap plan: ${result.planPath}`);
			if (!options.execute) {
				console.log('Pass --execute to run the planned clone/update-checkout commands.');
			}
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
