#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
	EMSCRIPTEN_REVISION,
	EMSCRIPTEN_VERSION,
	LLVM_REVISION,
	REPO_ROOT,
	loadProducerMetadata,
	resolveProducerPath,
	verifyLockedInputs
} from './contracts.mjs';

const defaultWorkDir = path.resolve(
	process.env.WASM_LLVM_LLDB_WORK_DIR || path.join(REPO_ROOT, 'artifacts', 'lldb-browser-build')
);

export function parsePrepareArgs(argv) {
	const options = {
		plan: false,
		skipEmsdkInstall: false,
		workDir: defaultWorkDir,
		sourceDir: process.env.LLVM_SOURCE_DIR ? path.resolve(process.env.LLVM_SOURCE_DIR) : '',
		emsdkDir: process.env.EMSDK ? path.resolve(process.env.EMSDK) : ''
	};
	for (let index = 0; index < argv.length; ++index) {
		const argument = argv[index];
		if (argument === '--') continue;
		if (argument === '--plan') {
			options.plan = true;
			continue;
		}
		if (argument === '--skip-emsdk-install') {
			options.skipEmsdkInstall = true;
			continue;
		}
		if (argument === '--help' || argument === '-h') {
			options.help = true;
			continue;
		}
		if (
			argument === '--work-dir' ||
			argument === '--source-dir' ||
			argument === '--emsdk-dir'
		) {
			const value = argv[++index];
			if (!value) throw new Error(`Missing value for ${argument}`);
			options[
				argument === '--work-dir'
					? 'workDir'
					: argument === '--source-dir'
						? 'sourceDir'
						: 'emsdkDir'
			] = path.resolve(value);
			continue;
		}
		throw new Error(`Unknown option: ${argument}`);
	}
	return options;
}

export function createPreparePlan(options, sourcesLock) {
	const sourceDir = options.sourceDir || path.join(options.workDir, 'llvm-project');
	const emsdkDir = options.emsdkDir || path.join(options.workDir, 'emsdk');
	return {
		kind: 'wasm-llvm-lldb-browser-prepare-plan',
		networkRequired: !options.sourceDir || (!options.emsdkDir && !options.skipEmsdkInstall),
		workDir: options.workDir,
		sourceDir,
		emsdkDir,
		llvm: { ...sourcesLock.llvm },
		emscripten: { ...sourcesLock.emscripten },
		patches: sourcesLock.patches.map((entry) => entry.path),
		overlays: sourcesLock.overlays.map(({ source, destination }) => ({
			source,
			destination
		})),
		steps: [
			'verify checked-in patch and overlay SHA-256 values',
			'checkout the exact LLVM revision without a branch',
			'copy browser overlays into the LLVM worktree',
			'apply checksum-locked patches idempotently',
			'install and activate the exact Emscripten SDK revision',
			'write prepare-state.json'
		]
	};
}

function run(command, commandArguments, options = {}) {
	return new Promise((resolve, reject) => {
		console.log(`+ ${[command, ...commandArguments].join(' ')}`);
		const child = spawn(command, commandArguments, {
			stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
			cwd: options.cwd,
			env: { ...process.env, ...(options.env || {}) }
		});
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on('data', (chunk) => {
			stderr += chunk;
		});
		child.on('error', reject);
		child.on('exit', (code) => {
			if (code === 0) resolve(options.capture ? stdout.trim() : undefined);
			else reject(new Error(`${command} exited with ${code}${stderr ? `\n${stderr}` : ''}`));
		});
	});
}

async function pathExists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function prepareCheckout(sourceDir, sourcesLock) {
	if (!(await pathExists(path.join(sourceDir, '.git')))) {
		if (await pathExists(sourceDir)) {
			throw new Error(`LLVM source directory exists but is not a Git checkout: ${sourceDir}`);
		}
		await fs.mkdir(path.dirname(sourceDir), { recursive: true });
		await run('git', [
			'clone',
			'--filter=blob:none',
			'--no-checkout',
			sourcesLock.llvm.repository,
			sourceDir
		]);
		await run('git', [
			'-C',
			sourceDir,
			'fetch',
			'--depth=1',
			'origin',
			sourcesLock.llvm.commit
		]);
		await run('git', ['-C', sourceDir, 'checkout', '--detach', sourcesLock.llvm.commit]);
	}

	const revision = await run('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], {
		capture: true
	});
	if (revision !== LLVM_REVISION) {
		throw new Error(`LLVM checkout is ${revision}; expected ${LLVM_REVISION}`);
	}
}

async function installOverlays(sourceDir, sourcesLock) {
	for (const overlay of sourcesLock.overlays) {
		const source = resolveProducerPath(overlay.source);
		const destination = path.resolve(sourceDir, overlay.destination);
		const relative = path.relative(sourceDir, destination);
		if (relative.startsWith('..') || path.isAbsolute(relative)) {
			throw new Error(`overlay destination escapes LLVM checkout: ${overlay.destination}`);
		}
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.copyFile(source, destination);
	}
}

async function applyPatches(sourceDir, sourcesLock) {
	for (const patch of sourcesLock.patches) {
		const patchPath = resolveProducerPath(patch.path);
		try {
			await run('git', ['-C', sourceDir, 'apply', '--check', patchPath]);
			await run('git', ['-C', sourceDir, 'apply', patchPath]);
		} catch (applyError) {
			try {
				await run('git', ['-C', sourceDir, 'apply', '--reverse', '--check', patchPath]);
			} catch {
				throw applyError;
			}
		}
	}
	await run('git', ['-C', sourceDir, 'diff', '--check']);
}

async function prepareEmsdk(emsdkDir, sourcesLock, skipInstall) {
	if (!(await pathExists(path.join(emsdkDir, '.git')))) {
		if (await pathExists(emsdkDir)) {
			throw new Error(`EMSDK directory exists but is not a Git checkout: ${emsdkDir}`);
		}
		await fs.mkdir(path.dirname(emsdkDir), { recursive: true });
		await run('git', [
			'clone',
			'--filter=blob:none',
			sourcesLock.emscripten.repository,
			emsdkDir
		]);
	}

	let revision = await run('git', ['-C', emsdkDir, 'rev-parse', 'HEAD'], {
		capture: true
	});
	if (revision !== EMSCRIPTEN_REVISION) {
		await run('git', ['-C', emsdkDir, 'fetch', '--depth=1', 'origin', EMSCRIPTEN_REVISION]);
		await run('git', ['-C', emsdkDir, 'checkout', '--detach', EMSCRIPTEN_REVISION]);
		revision = await run('git', ['-C', emsdkDir, 'rev-parse', 'HEAD'], {
			capture: true
		});
	}
	if (revision !== EMSCRIPTEN_REVISION) {
		throw new Error(`Emscripten checkout is ${revision}; expected ${EMSCRIPTEN_REVISION}`);
	}
	if (!skipInstall) {
		await run(path.join(emsdkDir, 'emsdk'), ['install', EMSCRIPTEN_VERSION]);
		await run(path.join(emsdkDir, 'emsdk'), ['activate', EMSCRIPTEN_VERSION]);
	}
}

async function main() {
	const options = parsePrepareArgs(process.argv.slice(2));
	if (options.help) {
		console.log(`Usage: node producer/lldb-browser/scripts/prepare.mjs [options]

Options:
  --plan                 Print the immutable preparation plan without writes/network.
  --work-dir DIR         Checkout/build workspace.
  --source-dir DIR       Use an existing exact LLVM checkout.
  --emsdk-dir DIR        Use an existing exact emsdk checkout.
  --skip-emsdk-install   Verify emsdk revision without installing packages.`);
		return;
	}

	const { sourcesLock } = await loadProducerMetadata();
	await verifyLockedInputs(sourcesLock);
	const plan = createPreparePlan(options, sourcesLock);
	if (options.plan) {
		console.log(JSON.stringify(plan, null, 2));
		return;
	}

	await fs.mkdir(options.workDir, { recursive: true });
	await prepareCheckout(plan.sourceDir, sourcesLock);
	await installOverlays(plan.sourceDir, sourcesLock);
	await applyPatches(plan.sourceDir, sourcesLock);
	await prepareEmsdk(plan.emsdkDir, sourcesLock, options.skipEmsdkInstall);
	await fs.writeFile(
		path.join(options.workDir, 'prepare-state.json'),
		JSON.stringify(
			{
				schemaVersion: 1,
				llvmRevision: LLVM_REVISION,
				emscriptenRevision: EMSCRIPTEN_REVISION,
				sourceDir: plan.sourceDir,
				emsdkDir: plan.emsdkDir
			},
			null,
			2
		) + '\n'
	);
	console.log(`Prepared LLDB browser sources in ${options.workDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
