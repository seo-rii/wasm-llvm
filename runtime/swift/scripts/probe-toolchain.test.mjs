import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
	OFFICIAL_SWIFT_VERSION,
	OFFICIAL_WASM_SDK_CHECKSUM,
	OFFICIAL_WASM_SDK_ID,
	OFFICIAL_WASM_SDK_URL,
	assertWasm,
	findBuiltWasm,
	parseArgs,
	probeSwiftToolchain,
	run,
	selectWasmSdkId,
	swiftWasmInstallCommand,
	swiftWasmMetadata,
	writeProbePackage
} from './probe-toolchain.mjs';

test('exposes the official Swift Wasm SDK metadata', () => {
	assert.deepEqual(swiftWasmMetadata(), {
		swiftVersion: OFFICIAL_SWIFT_VERSION,
		wasmSdkId: OFFICIAL_WASM_SDK_ID,
		wasmSdkUrl: OFFICIAL_WASM_SDK_URL,
		wasmSdkChecksum: OFFICIAL_WASM_SDK_CHECKSUM
	});
	assert.match(OFFICIAL_WASM_SDK_URL, /^https:\/\/download\.swift\.org\//u);
	assert.match(OFFICIAL_WASM_SDK_CHECKSUM, /^[a-f0-9]{64}$/u);
});

test('prints the native Swift and Wasm SDK install commands', () => {
	assert.equal(
		swiftWasmInstallCommand(),
		[
			`swiftly install ${OFFICIAL_SWIFT_VERSION}`,
			`swiftly use ${OFFICIAL_SWIFT_VERSION}`,
			`swift sdk install ${OFFICIAL_WASM_SDK_URL} --checksum ${OFFICIAL_WASM_SDK_CHECKSUM}`
		].join('\n')
	);
});

test('parses and validates Swift toolchain probe CLI arguments', () => {
	assert.deepEqual(parseArgs([]), {
		metadataOnly: false,
		printInstall: false,
		runWasm: false,
		sdkId: null,
		receiptPath: null
	});
	assert.deepEqual(parseArgs(['--metadata-only']), {
		metadataOnly: true,
		printInstall: false,
		runWasm: false,
		sdkId: null,
		receiptPath: null
	});
	assert.deepEqual(parseArgs(['--print-install']), {
		metadataOnly: false,
		printInstall: true,
		runWasm: false,
		sdkId: null,
		receiptPath: null
	});
	assert.deepEqual(parseArgs(['--run-wasm']), {
		metadataOnly: false,
		printInstall: false,
		runWasm: true,
		sdkId: null,
		receiptPath: null
	});
	assert.deepEqual(parseArgs(['--', '--run-wasm']), {
		metadataOnly: false,
		printInstall: false,
		runWasm: true,
		sdkId: null,
		receiptPath: null
	});
	assert.deepEqual(parseArgs(['--metadata-only', '--print-install']), {
		metadataOnly: true,
		printInstall: true,
		runWasm: false,
		sdkId: null,
		receiptPath: null
	});
	assert.deepEqual(parseArgs(['--receipt', 'receipt.json']), {
		metadataOnly: false,
		printInstall: false,
		runWasm: false,
		sdkId: null,
		receiptPath: path.resolve('receipt.json')
	});
	assert.deepEqual(parseArgs(['--run-wasm', '--receipt', 'receipt.json']), {
		metadataOnly: false,
		printInstall: false,
		runWasm: true,
		sdkId: null,
		receiptPath: path.resolve('receipt.json')
	});
	assert.deepEqual(parseArgs(['--sdk-id', 'swift-DEVELOPMENT-SNAPSHOT_wasm']), {
		metadataOnly: false,
		printInstall: false,
		runWasm: false,
		sdkId: 'swift-DEVELOPMENT-SNAPSHOT_wasm',
		receiptPath: null
	});
	assert.throws(() => parseArgs(['--receipt']), /--receipt requires a value/u);
	assert.throws(() => parseArgs(['--sdk-id']), /--sdk-id requires a value/u);
	assert.throws(() => parseArgs(['--unknown']), /Unknown option: --unknown/u);
});

test('passes stdin into child processes for the optional Swift Wasm execution probe', async () => {
	const result = await run(
		process.execPath,
		[
			'-e',
			'process.stdin.setEncoding("utf8");let input="";process.stdin.on("data",(chunk)=>input+=chunk);process.stdin.on("end",()=>process.stdout.write("swift-stdin:"+input.trimEnd()+"\\n"));'
		],
		{ input: 'hello wasm-idle\n' }
	);

	assert.equal(result.stdout, 'swift-stdin:hello wasm-idle\n');
});

test('selects a full Swift Wasm SDK and rejects embedded-only SDKs', () => {
	assert.equal(
		selectWasmSdkId(
			[
				'Installed Swift SDKs:',
				`  ${OFFICIAL_WASM_SDK_ID}`,
				`  ${OFFICIAL_WASM_SDK_ID}_embedded`
			].join('\n')
		),
		OFFICIAL_WASM_SDK_ID
	);
	assert.equal(
		selectWasmSdkId('swift-DEVELOPMENT-SNAPSHOT-2026-01-01-a_wasm\n'),
		'swift-DEVELOPMENT-SNAPSHOT-2026-01-01-a_wasm'
	);
	assert.equal(
		selectWasmSdkId(
			`${OFFICIAL_WASM_SDK_ID}\nswift-DEVELOPMENT-SNAPSHOT_wasm\n`,
			'swift-DEVELOPMENT-SNAPSHOT_wasm'
		),
		'swift-DEVELOPMENT-SNAPSHOT_wasm'
	);
	assert.throws(
		() => selectWasmSdkId(`${OFFICIAL_WASM_SDK_ID}\n`, 'swift-DEVELOPMENT-SNAPSHOT_wasm'),
		/Requested Swift Wasm SDK was not found/u
	);
	assert.throws(
		() => selectWasmSdkId('swift-6.3.3-RELEASE_wasm_embedded\n'),
		/embedded Swift Wasm SDKs[\s\S]*requires a full Swift Wasm SDK/u
	);
	assert.throws(() => selectWasmSdkId(''), /No Swift Wasm SDK was found/u);
	assert.throws(() => selectWasmSdkId('Installed Swift SDKs:\n  linux\n'), /No Swift Wasm SDK/u);
});

test('probes the Swift toolchain through an injectable command runner', async () => {
	const calls = [];
	const result = await probeSwiftToolchain({
		runWasm: true,
		runCommand: async (command, args, options = {}) => {
			calls.push({ command, args, cwd: options.cwd, input: options.input });
			if (args.join(' ') === '--version') return { stdout: 'Swift version 6.3.3\n', stderr: '' };
			if (args.join(' ') === 'sdk list') {
				return { stdout: `${OFFICIAL_WASM_SDK_ID}\n`, stderr: '' };
			}
			if (args[0] === 'build') {
				const outputDir = path.join(options.cwd, '.build', 'release');
				await mkdir(outputDir, { recursive: true });
				await writeFile(
					path.join(outputDir, 'WasmIdleSwiftProbe.wasm'),
					Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)
				);
				return { stdout: '', stderr: '' };
			}
			if (args[0] === 'run') {
				assert.equal(options.input, 'hello wasm-idle\n');
				return { stdout: 'swift-stdin:hello wasm-idle\n', stderr: '' };
			}
			throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
		}
	});

	assert.equal(result.hostSwift, 'Swift version 6.3.3');
	assert.equal(result.selectedSdk, OFFICIAL_WASM_SDK_ID);
	assert.equal(result.wasmBytes, 8);
	assert.equal(result.runStdout, 'swift-stdin:hello wasm-idle\n');
	assert.deepEqual(
		calls.map((call) => call.args.join(' ')),
		['--version', 'sdk list', `build --swift-sdk ${OFFICIAL_WASM_SDK_ID} -c release`, `run --swift-sdk ${OFFICIAL_WASM_SDK_ID} -c release`]
	);
});

test('reports Swift toolchain probe CLI argument errors without stack traces', async () => {
	const { spawnSync } = await import('node:child_process');
	const result = spawnSync(
		process.execPath,
		[path.resolve(import.meta.dirname, 'probe-toolchain.mjs'), '--unknown'],
		{ encoding: 'utf8' }
	);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Unknown option: --unknown/u);
	assert.doesNotMatch(result.stderr, /\n\s+at /u);
});

test('writes a Swift toolchain probe receipt from the CLI', async () => {
	const { spawnSync } = await import('node:child_process');
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-probe-receipt-'));
	try {
		const receiptPath = path.join(dir, 'receipt.json');
		const swiftStub = path.join(dir, 'swift');
		await writeFile(
			swiftStub,
			`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.join(' ') === '--version') {
  process.stdout.write('Swift version 6.3.3\\n');
  process.exit(0);
}
if (args.join(' ') === 'sdk list') {
  process.stdout.write('${OFFICIAL_WASM_SDK_ID}\\n');
  process.exit(0);
}
if (args[0] === 'build') {
  const output = path.join(process.cwd(), '.build', 'wasm32-unknown-wasip1', 'release', 'WasmIdleSwiftProbe.wasm');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  process.exit(0);
}
process.stderr.write('unexpected swift args: ' + args.join(' ') + '\\n');
process.exit(1);
`,
			{ mode: 0o755 }
		);
		const result = spawnSync(
			process.execPath,
			[path.resolve(import.meta.dirname, 'probe-toolchain.mjs'), '--receipt', receiptPath],
			{
				encoding: 'utf8',
				env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }
			}
		);

		assert.equal(result.status, 0, result.stderr);
		const stdout = JSON.parse(result.stdout);
		const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
		assert.equal(receipt.format, 'wasm-idle-swift-toolchain-probe-v1');
		assert.match(receipt.startedAt, /^\d{4}-\d{2}-\d{2}T/u);
		assert.equal(receipt.runWasm, false);
		assert.equal(receipt.selectedSdk, OFFICIAL_WASM_SDK_ID);
		assert.equal(receipt.wasmBytes, 8);
		assert.equal(stdout.selectedSdk, OFFICIAL_WASM_SDK_ID);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('writes the stdin probe package sources', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-test-'));
	try {
		await writeProbePackage(dir);
		const manifest = await readFile(path.join(dir, 'Package.swift'), 'utf8');
		const source = await readFile(
			path.join(dir, 'Sources', 'WasmIdleSwiftProbe', 'main.swift'),
			'utf8'
		);
		assert.match(manifest, /executableTarget\(name: "WasmIdleSwiftProbe"\)/u);
		assert.match(source, /readLine\(\)/u);
		assert.match(source, /swift-stdin:/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('finds and validates wasm artifacts by magic header', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-test-'));
	try {
		const nested = path.join(dir, '.build', 'release');
		await writeProbePackage(dir);
		await mkdir(nested, { recursive: true });
		await writeFile(
			path.join(nested, 'WasmIdleSwiftProbe.wasm'),
			Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)
		);
		const wasmPath = await findBuiltWasm(path.join(dir, '.build'));
		assert.equal(wasmPath, path.join(nested, 'WasmIdleSwiftProbe.wasm'));
		assert.equal(await assertWasm(wasmPath), 8);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects wasm artifacts with an invalid binary version header', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-test-'));
	try {
		const wasmPath = path.join(dir, 'invalid-version.wasm');
		await writeFile(wasmPath, Uint8Array.of(0, 97, 115, 109, 0, 0, 0, 0));

		await assert.rejects(() => assertWasm(wasmPath), /is not a WebAssembly binary/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
