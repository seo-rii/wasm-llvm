#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const OFFICIAL_SWIFT_VERSION = '6.3.3';
export const OFFICIAL_WASM_SDK_ID = 'swift-6.3.3-RELEASE_wasm';
export const OFFICIAL_WASM_SDK_URL =
	'https://download.swift.org/swift-6.3.3-release/wasm-sdk/swift-6.3.3-RELEASE/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz';
export const OFFICIAL_WASM_SDK_CHECKSUM =
	'cabfa08b73bb8ac783927ecd15fa386e99d0c139c5f232445067bcf58379cae7';

export function swiftWasmMetadata() {
	return {
		swiftVersion: OFFICIAL_SWIFT_VERSION,
		wasmSdkId: OFFICIAL_WASM_SDK_ID,
		wasmSdkUrl: OFFICIAL_WASM_SDK_URL,
		wasmSdkChecksum: OFFICIAL_WASM_SDK_CHECKSUM
	};
}

export function swiftWasmInstallCommand() {
	return [
		`swiftly install ${OFFICIAL_SWIFT_VERSION}`,
		`swiftly use ${OFFICIAL_SWIFT_VERSION}`,
		`swift sdk install ${OFFICIAL_WASM_SDK_URL} --checksum ${OFFICIAL_WASM_SDK_CHECKSUM}`
	].join('\n');
}

export function parseArgs(argv) {
	const options = {
		metadataOnly: false,
		printInstall: false,
		runWasm: false,
		sdkId: null,
		receiptPath: null
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--') continue;
		else if (arg === '--metadata-only') options.metadataOnly = true;
		else if (arg === '--print-install') options.printInstall = true;
		else if (arg === '--run-wasm') options.runWasm = true;
		else if (arg === '--sdk-id') {
			const value = argv[index + 1];
			if (typeof value !== 'string' || !value || value.startsWith('--')) {
				throw new Error('--sdk-id requires a value');
			}
			options.sdkId = value;
			index += 1;
		}
		else if (arg === '--receipt') {
			const value = argv[index + 1];
			if (typeof value !== 'string' || !value || value.startsWith('--')) {
				throw new Error('--receipt requires a value');
			}
			options.receiptPath = path.resolve(value);
			index += 1;
		}
		else throw new Error(`Unknown option: ${arg}`);
	}
	return options;
}

export function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: process.env,
			stdio: [typeof options.input === 'string' ? 'pipe' : 'ignore', 'pipe', 'pipe']
		});
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
		child.on('error', reject);
		child.on('close', (code, signal) => {
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			const suffix = signal ? `signal ${signal}` : `code ${String(code)}`;
			reject(
				new Error(`${command} ${args.join(' ')} failed with ${suffix}\n${stderr}${stdout}`)
			);
		});
		if (typeof options.input === 'string') {
			child.stdin.end(options.input);
		}
	});
}

export function selectWasmSdkId(sdkListOutput, requestedSdkId = null) {
	if (typeof sdkListOutput !== 'string' || !sdkListOutput.trim()) {
		throw new Error(
			`No Swift Wasm SDK was found in "swift sdk list". Expected ${OFFICIAL_WASM_SDK_ID}.\nRun:\n` +
				`swift sdk install ${OFFICIAL_WASM_SDK_URL} --checksum ${OFFICIAL_WASM_SDK_CHECKSUM}`
		);
	}
	const sdkIds = [...sdkListOutput.matchAll(/\b[A-Za-z0-9.+-]+_wasm(?:_[A-Za-z0-9.+-]+)?\b/gu)].map(
		(match) => match[0]
	);
	if (requestedSdkId) {
		if (sdkIds.includes(requestedSdkId)) return requestedSdkId;
		throw new Error(`Requested Swift Wasm SDK was not found: ${requestedSdkId}`);
	}
	if (sdkIds.includes(OFFICIAL_WASM_SDK_ID)) return OFFICIAL_WASM_SDK_ID;
	const fullSdkId = sdkIds.find((sdkId) => /_wasm$/u.test(sdkId));
	if (fullSdkId) return fullSdkId;
	if (sdkIds.length > 0) {
		throw new Error(
			`Only embedded Swift Wasm SDKs were found in "swift sdk list": ${sdkIds.join(', ')}. wasm-idle requires a full Swift Wasm SDK, not an Embedded Swift subset.`
		);
	}
	throw new Error(
		`No Swift Wasm SDK was found in "swift sdk list". Expected ${OFFICIAL_WASM_SDK_ID} or another full *_wasm SDK.\nRun:\n` +
			`swift sdk install ${OFFICIAL_WASM_SDK_URL} --checksum ${OFFICIAL_WASM_SDK_CHECKSUM}`
	);
}

export async function findBuiltWasm(dir) {
	const queue = [dir];
	while (queue.length > 0) {
		const current = queue.shift();
		const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(entryPath);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith('.wasm')) return entryPath;
		}
	}
	return null;
}

export async function assertWasm(filePath) {
	const bytes = await readFile(filePath);
	if (
		bytes.byteLength < 8 ||
		bytes[0] !== 0x00 ||
		bytes[1] !== 0x61 ||
		bytes[2] !== 0x73 ||
		bytes[3] !== 0x6d ||
		bytes[4] !== 0x01 ||
		bytes[5] !== 0x00 ||
		bytes[6] !== 0x00 ||
		bytes[7] !== 0x00
	) {
		throw new Error(`${filePath} is not a WebAssembly binary.`);
	}
	return bytes.byteLength;
}

export async function writeProbePackage(dir) {
	await writeFile(
		path.join(dir, 'Package.swift'),
		`// swift-tools-version: 6.3
import PackageDescription

let package = Package(
    name: "WasmIdleSwiftProbe",
    targets: [
        .executableTarget(name: "WasmIdleSwiftProbe")
    ]
)
`,
		'utf8'
	);
	const sourceDir = path.join(dir, 'Sources', 'WasmIdleSwiftProbe');
	await mkdir(sourceDir, { recursive: true });
	await writeFile(
		path.join(sourceDir, 'main.swift'),
		`let input = readLine() ?? ""
print("swift-stdin:\\(input)")
`,
		'utf8'
	);
}

export async function probeSwiftToolchain({ runWasm = false, sdkId: requestedSdkId = null, runCommand = run } = {}) {
	const metadata = swiftWasmMetadata();
	const swiftVersion = await runCommand('swift', ['--version']).catch((error) => {
		throw new Error(
			`Swift toolchain is not available. Install Swift ${OFFICIAL_SWIFT_VERSION} and the Wasm SDK first.\n${error.message}`
		);
	});
	const sdkList = await runCommand('swift', ['sdk', 'list']).catch((error) => {
		throw new Error(`Unable to list Swift SDKs. Install the Wasm SDK first.\n${error.message}`);
	});
	const sdkId = selectWasmSdkId(sdkList.stdout, requestedSdkId);

	const workDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-'));
	try {
		await writeProbePackage(workDir);
		await runCommand('swift', ['build', '--swift-sdk', sdkId, '-c', 'release'], { cwd: workDir });
		const wasmPath = await findBuiltWasm(path.join(workDir, '.build'));
		if (!wasmPath) throw new Error('Swift build completed but no .wasm artifact was found.');
		const wasmBytes = await assertWasm(wasmPath);
		let runStdout;
		if (runWasm) {
			const runResult = await runCommand('swift', ['run', '--swift-sdk', sdkId, '-c', 'release'], {
				cwd: workDir,
				input: 'hello wasm-idle\n'
			});
			runStdout = runResult.stdout;
			if (runStdout !== 'swift-stdin:hello wasm-idle\n') {
				throw new Error(
					`Swift Wasm stdin probe produced unexpected stdout.\nExpected: swift-stdin:hello wasm-idle\nActual: ${runStdout}`
				);
			}
		}
		return {
			...metadata,
			hostSwift: swiftVersion.stdout.trim(),
			selectedSdk: sdkId,
			wasmPath,
			wasmBytes,
			...(runWasm ? { runStdout } : {})
		};
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

export async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	const metadata = swiftWasmMetadata();

	if (args.printInstall) {
		console.log(swiftWasmInstallCommand());
		return;
	}

	if (args.metadataOnly) {
		console.log(JSON.stringify(metadata, null, 2));
		return;
	}

	const result = await probeSwiftToolchain({ runWasm: args.runWasm, sdkId: args.sdkId });
	if (args.receiptPath) {
		const receipt = {
			format: 'wasm-idle-swift-toolchain-probe-v1',
			startedAt: new Date().toISOString(),
			runWasm: args.runWasm,
			...result
		};
		await mkdir(path.dirname(args.receiptPath), { recursive: true });
		await writeFile(args.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
	}
	console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
