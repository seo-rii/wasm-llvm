#!/usr/bin/env node
import { access as accessFile, mkdir, rm, stat as statFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const RUNTIME_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const TARGET = 'wasm32-unknown-wasip1';
const STDIN = 'swift-stdin-ok\n';
const EXPECTED_STDOUT = 'swift-stdin:swift-stdin-ok\n';

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
			env: options.env ? { ...process.env, ...options.env } : process.env,
			stdio: [typeof options.input === 'string' ? 'pipe' : 'ignore', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk) => { stdout += chunk; });
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		child.on('error', reject);
		child.on('close', (exitCode, signal) => {
			resolve({ exitCode, signal, stdout, stderr });
		});
		if (typeof options.input === 'string') child.stdin.end(options.input);
	});
}

export function parseVerifyWasiFrontendArgs(argv) {
	const options = {
		sourceRoot: null,
		buildDir: null,
		nativeBuildDir: null,
		frontendPath: null,
		workDir: null,
		receiptPath: null
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--') continue;
		if (arg === '--help') return { help: true };
		if (arg === '--source-root') options.sourceRoot = path.resolve(readOptionValue(argv, index++, arg));
		else if (arg === '--build-dir') options.buildDir = path.resolve(readOptionValue(argv, index++, arg));
		else if (arg === '--native-build-dir') {
			options.nativeBuildDir = path.resolve(readOptionValue(argv, index++, arg));
		} else if (arg === '--frontend') options.frontendPath = path.resolve(readOptionValue(argv, index++, arg));
		else if (arg === '--work-dir') options.workDir = path.resolve(readOptionValue(argv, index++, arg));
		else if (arg === '--receipt') options.receiptPath = path.resolve(readOptionValue(argv, index++, arg));
		else throw new Error(`Unknown option: ${arg}`);
	}
	if (!options.sourceRoot) throw new Error('--source-root is required');
	options.buildDir ??= path.join(options.sourceRoot, 'browser-compiler-wasi');
	options.nativeBuildDir ??= path.join(options.sourceRoot, 'build', 'buildbot_linux');
	options.frontendPath ??= path.join(options.buildDir, 'swift-wasi', 'bin', 'swift-frontend');
	options.workDir ??= path.join(options.buildDir, 'wasi-frontend-verification');
	options.receiptPath ??= path.join(
		options.buildDir,
		'wasm-idle-swift-wasi-frontend-verification.json'
	);
	return options;
}

function wasmKitCommand(wasmKit, preopenDirectories, modulePath, args) {
	return [
		wasmKit,
		'run',
		'--stack-size', '67108864',
		...preopenDirectories.flatMap((directory) => ['--dir', directory]),
		modulePath,
		...args
	];
}

export function createVerifyWasiFrontendCommands(options) {
	const nativeLlvmDir = path.join(options.nativeBuildDir, 'llvm-linux-x86_64');
	const swiftResourceDir = path.join(
		options.nativeBuildDir,
		'wasmstdlib-linux-x86_64',
		'lib',
		'swift_static'
	);
	const swiftRuntimeDir = path.join(swiftResourceDir, 'wasi');
	const paths = {
		wasmKit: path.join(
			options.nativeBuildDir,
			'wasmkit-linux-x86_64',
			'x86_64-unknown-linux-gnu',
			'release',
			'wasmkit-cli'
		),
		wasmKitLibraryDir: path.join(
			options.nativeBuildDir,
			'none-swift_package_sandbox_linux-x86_64',
			'usr',
			'lib',
			'swift',
			'linux'
		),
		frontend: options.frontendPath,
		autolinkExtract: path.join(path.dirname(options.frontendPath), 'swift-autolink-extract'),
		clang: path.join(nativeLlvmDir, 'bin', 'clang'),
		wasiSysroot: path.join(options.nativeBuildDir, 'wasi-sysroot', 'wasm32-wasip1', 'sysroot'),
		swiftResourceDir,
		swiftRuntimeDir,
		swiftRuntimeObject: path.join(swiftRuntimeDir, 'wasm32', 'swiftrt.o'),
		staticExecutableArgs: path.join(swiftRuntimeDir, 'static-executable-args.lnk'),
		wasiResourceDir: path.join(
			options.nativeBuildDir,
			'wasi-sysroot',
			'wasm32-wasip1',
			'resource-dir'
		),
		builtins: path.join(
			options.nativeBuildDir,
			'wasi-sysroot',
			'wasm32-wasip1',
			'resource-dir',
			'lib',
			'wasip1',
			'libclang_rt.builtins-wasm32.a'
		),
		swiftSource: path.join(RUNTIME_ROOT, 'fixtures', 'wasi-stdin-echo.swift'),
		swiftObject: path.join(options.workDir, 'wasi-stdin-echo.swift.o'),
		autolinkFile: path.join(options.workDir, 'wasi-stdin-echo.autolink'),
		moduleCache: path.join(options.workDir, 'module-cache'),
		wasmOutput: path.join(options.workDir, 'wasi-stdin-echo.wasm')
	};
	const preopenDirectories = [...new Set([
		options.sourceRoot,
		options.buildDir,
		options.nativeBuildDir,
		options.workDir,
		RUNTIME_ROOT
	])];
	const commands = {
		compileSwift: wasmKitCommand(paths.wasmKit, preopenDirectories, paths.frontend, [
			'-frontend',
			'-c',
			'-primary-file', paths.swiftSource,
			'-target', TARGET,
			'-disable-objc-interop',
			'-sdk', paths.wasiSysroot,
			'-resource-dir', paths.swiftResourceDir,
			'-use-static-resource-dir',
			'-module-cache-path', paths.moduleCache,
			'-module-name', 'main',
			'-o', paths.swiftObject
		]),
		extractAutolink: wasmKitCommand(paths.wasmKit, preopenDirectories, paths.autolinkExtract, [
			paths.swiftObject,
			'-o', paths.autolinkFile
		]),
		link: [
			paths.clang,
			`--target=${TARGET}`,
			'--sysroot', paths.wasiSysroot,
			'-resource-dir', paths.wasiResourceDir,
			paths.swiftRuntimeObject,
			paths.swiftObject,
			`@${paths.autolinkFile}`,
			'-L', paths.swiftRuntimeDir,
			`@${paths.staticExecutableArgs}`,
			'-Wl,--global-base=4096',
			'-Wl,--table-base=4096',
			'-Wl,-z,stack-size=131072',
			'-o', paths.wasmOutput
		],
		runWasm: [paths.wasmKit, 'run', paths.wasmOutput]
	};
	return { paths, preopenDirectories, commands };
}

async function runChecked(label, command, run, options = {}) {
	const result = await run(command[0], command.slice(1), options);
	const exitCode = result?.exitCode ?? 0;
	if (exitCode !== 0) {
		const reason = result?.signal ? `signal ${result.signal}` : `code ${exitCode}`;
		const diagnostics = `${result?.stderr ?? ''}${result?.stdout ?? ''}`;
		throw new Error(`${label} failed with ${reason}${diagnostics ? `\n${diagnostics}` : ''}`);
	}
	return {
		exitCode,
		signal: result?.signal ?? null,
		stdout: result?.stdout ?? '',
		stderr: result?.stderr ?? ''
	};
}

async function inspectOutput(label, filePath, inspectStat) {
	let outputStat;
	try {
		outputStat = await inspectStat(filePath);
	} catch {
		throw new Error(`${label} exited successfully but did not produce ${filePath}`);
	}
	if (typeof outputStat?.isFile === 'function' && !outputStat.isFile()) {
		throw new Error(`${label} did not produce a file at ${filePath}`);
	}
	const bytes = Number(outputStat?.size ?? 0);
	if (Number.isFinite(bytes) && bytes <= 0) {
		throw new Error(`${label} produced an empty file at ${filePath}`);
	}
	return { path: filePath, bytes };
}

export async function verifyWasiFrontend(
	options,
	{ run = runCommand, access = accessFile, stat = statFile } = {}
) {
	const plan = createVerifyWasiFrontendCommands(options);
	const startedAt = new Date().toISOString();
	let status = 'passed';
	let errorMessage = null;
	let actualStdout = null;
	const outputs = {};
	await mkdir(path.dirname(options.receiptPath), { recursive: true });
	try {
		await mkdir(options.workDir, { recursive: true });
		for (const outputPath of [
			plan.paths.swiftObject,
			plan.paths.autolinkFile,
			plan.paths.wasmOutput
		]) {
			await rm(outputPath, { force: true });
		}
		for (const requiredPath of [
			plan.paths.wasmKit,
			plan.paths.wasmKitLibraryDir,
			plan.paths.frontend,
			plan.paths.autolinkExtract,
			plan.paths.clang,
			plan.paths.wasiSysroot,
			plan.paths.swiftResourceDir,
			plan.paths.swiftRuntimeObject,
			plan.paths.staticExecutableArgs,
			plan.paths.wasiResourceDir,
			plan.paths.builtins,
			plan.paths.swiftSource
		]) {
			await access(requiredPath);
		}

		const wasmKitRunOptions = {
			cwd: options.workDir,
			env: { LD_LIBRARY_PATH: plan.paths.wasmKitLibraryDir }
		};
		await runChecked('swift-frontend', plan.commands.compileSwift, run, wasmKitRunOptions);
		outputs.swiftObject = await inspectOutput(
			'swift-frontend', plan.paths.swiftObject, stat
		);
		await runChecked(
			'swift-autolink-extract', plan.commands.extractAutolink, run, wasmKitRunOptions
		);
		outputs.autolinkFile = await inspectOutput(
			'swift-autolink-extract', plan.paths.autolinkFile, stat
		);
		await runChecked('clang WASI link', plan.commands.link, run, { cwd: options.workDir });
		outputs.wasm = await inspectOutput('clang WASI link', plan.paths.wasmOutput, stat);

		const execution = await runChecked('WasmKit execution', plan.commands.runWasm, run, {
			...wasmKitRunOptions,
			input: STDIN
		});
		actualStdout = execution.stdout;
		if (actualStdout !== EXPECTED_STDOUT) {
			throw new Error(
				`WasmKit execution produced unexpected stdout.\nExpected: ${JSON.stringify(EXPECTED_STDOUT)}\n` +
					`Actual: ${JSON.stringify(actualStdout)}`
			);
		}
	} catch (error) {
		status = 'failed';
		errorMessage = error instanceof Error ? error.message : String(error);
	}
	const receipt = {
		format: 'wasm-idle-swift-wasi-frontend-verification-v1',
		status,
		sourceRoot: options.sourceRoot,
		buildDir: options.buildDir,
		nativeBuildDir: options.nativeBuildDir,
		frontendPath: options.frontendPath,
		workDir: options.workDir,
		receiptPath: options.receiptPath,
		target: TARGET,
		stdin: STDIN,
		expectedStdout: EXPECTED_STDOUT,
		actualStdout,
		paths: plan.paths,
		commands: plan.commands,
		outputs,
		startedAt,
		finishedAt: new Date().toISOString(),
		errorMessage
	};
	await writeFile(options.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
	if (status === 'failed') throw new Error(errorMessage);
	return receipt;
}

function usage() {
	return `Usage: node runtime/swift/scripts/verify-wasi-frontend.mjs --source-root <swift checkout> [options]

Compiles and runs the Swift WASI stdin fixture through the WasmKit-hosted frontend.

Options:
  --build-dir <dir>         Browser compiler build root
  --native-build-dir <dir>  Existing build-script native build root
  --frontend <file>         WASI swift-frontend module
  --work-dir <dir>          Verification intermediate/output directory
  --receipt <file>          Verification receipt path`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		const options = parseVerifyWasiFrontendArgs(process.argv.slice(2));
		if (options.help) console.log(usage());
		else {
			const receipt = await verifyWasiFrontend(options);
			console.log(`${receipt.status}: ${options.receiptPath}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
