import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
	parsePrepareRawRuntimeArgs,
	prepareSwiftRawRuntime
} from './prepare-raw-runtime.mjs';
import {
	OFFICIAL_WASM_SDK_CHECKSUM,
	OFFICIAL_WASM_SDK_URL
} from './probe-toolchain.mjs';

const VALID_RUNNER_WORKER_SOURCE = `
self.onmessage = async (event) => {
	const {
		run,
		baseUrl,
		manifestUrl,
		code,
		stdin,
		args = [],
		activePath,
		workspaceFiles = []
	} = event.data || {};
	const manifest = await (await fetch(manifestUrl)).json();
	const swiftcUrl = new URL('swiftc.wasm', baseUrl).href;
	const swiftpmUrl = new URL('swiftpm.wasm', baseUrl).href;
	const sdkUrl = new URL('sdk.tar.gz', baseUrl).href;
	if (!run || !manifest || !code || !stdin || !args || !activePath || !workspaceFiles) {
		self.postMessage({ error: 'invalid Swift run message' });
		return;
	}
	self.postMessage({ progress: { percent: 1, stage: 'Loading Swift' } });
	self.postMessage({ output: [swiftcUrl, swiftpmUrl, sdkUrl].join('\\n').slice(0, 0) });
	self.postMessage({ results: true });
};
`;
const VALID_SDK_ARCHIVE_BYTES = Uint8Array.from(gzipSync(Uint8Array.of(115, 100, 107)));

function taggedWasm(tag) {
	const sectionName = Buffer.from('wasm-idle-test', 'utf8');
	const tagBytes = Buffer.from(tag, 'utf8');
	return Uint8Array.of(
		0,
		97,
		115,
		109,
		1,
		0,
		0,
		0,
		0,
		1 + sectionName.byteLength + tagBytes.byteLength,
		sectionName.byteLength,
		...sectionName,
		...tagBytes
	);
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

async function writeFixtureFile(filePath, contents) {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, contents);
	return filePath;
}

test('parses Swift raw runtime preparation arguments', () => {
	assert.deepEqual(parsePrepareRawRuntimeArgs(['--help']), { help: true });
	assert.deepEqual(parsePrepareRawRuntimeArgs([]), {
		sourceDir: path.resolve(import.meta.dirname, '..', 'raw-runtime'),
		inputs: {},
		fetchOfficialSdk: false,
		sdkUrl: OFFICIAL_WASM_SDK_URL,
		sdkChecksum: OFFICIAL_WASM_SDK_CHECKSUM,
		allowIncomplete: false
	});
	assert.deepEqual(
		parsePrepareRawRuntimeArgs([
			'--source-dir',
			'raw',
			'--runner-worker',
			'worker.js',
			'--swiftc-wasm',
			'swiftc.wasm',
			'--swiftpm-wasm',
			'swiftpm.wasm',
			'--sdk-archive',
			'sdk.tar.gz',
			'--fetch-official-sdk',
			'--allow-incomplete'
		]),
		{
			sourceDir: path.resolve('raw'),
			inputs: {
				'runner-worker.js': path.resolve('worker.js'),
				'swiftc.wasm': path.resolve('swiftc.wasm'),
				'swiftpm.wasm': path.resolve('swiftpm.wasm'),
				'sdk.tar.gz': path.resolve('sdk.tar.gz')
			},
			fetchOfficialSdk: true,
			sdkUrl: OFFICIAL_WASM_SDK_URL,
			sdkChecksum: OFFICIAL_WASM_SDK_CHECKSUM,
			allowIncomplete: true
		}
	);
	assert.throws(() => parsePrepareRawRuntimeArgs(['--source-dir']), /--source-dir requires a value/u);
	assert.throws(() => parsePrepareRawRuntimeArgs(['--unknown']), /Unknown option: --unknown/u);
});

test('prepares a packageable Swift raw runtime from explicit inputs', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-prepare-'));
	try {
		const sourceDir = path.join(dir, 'raw-runtime');
		const inputsDir = path.join(dir, 'inputs');
		const result = await prepareSwiftRawRuntime({
			sourceDir,
			inputs: {
				'runner-worker.js': await writeFixtureFile(
					path.join(inputsDir, 'worker.js'),
					VALID_RUNNER_WORKER_SOURCE
				),
				'swiftc.wasm': await writeFixtureFile(
					path.join(inputsDir, 'compiler.wasm'),
					taggedWasm('swiftc Swift compiler')
				),
				'swiftpm.wasm': await writeFixtureFile(
					path.join(inputsDir, 'swiftpm.wasm'),
					taggedWasm('swiftpm SwiftPM')
				),
				'sdk.tar.gz': await writeFixtureFile(
					path.join(inputsDir, 'sdk.tar.gz'),
					VALID_SDK_ARCHIVE_BYTES
				)
			}
		});

		assert.deepEqual(result, { sourceDir, ready: true, missing: [] });
		assert.equal(await readFile(path.join(sourceDir, 'runner-worker.js'), 'utf8'), VALID_RUNNER_WORKER_SOURCE);
		assert.deepEqual(
			new Uint8Array(await readFile(path.join(sourceDir, 'swiftc.wasm'))),
			taggedWasm('swiftc Swift compiler')
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('fetches the official SDK archive while preparing a raw runtime', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-prepare-fetch-'));
	try {
		const sourceDir = path.join(dir, 'raw-runtime');
		const inputsDir = path.join(dir, 'inputs');
		const sdkBytes = VALID_SDK_ARCHIVE_BYTES;
		const result = await prepareSwiftRawRuntime({
			sourceDir,
			fetchOfficialSdk: true,
			sdkChecksum: sha256(sdkBytes),
			fetchImpl: async () => ({
				ok: true,
				status: 200,
				arrayBuffer: async () =>
					sdkBytes.buffer.slice(sdkBytes.byteOffset, sdkBytes.byteOffset + sdkBytes.byteLength)
			}),
			inputs: {
				'runner-worker.js': await writeFixtureFile(
					path.join(inputsDir, 'worker.js'),
					VALID_RUNNER_WORKER_SOURCE
				),
				'swiftc.wasm': await writeFixtureFile(
					path.join(inputsDir, 'compiler.wasm'),
					taggedWasm('swiftc Swift compiler')
				),
				'swiftpm.wasm': await writeFixtureFile(
					path.join(inputsDir, 'swiftpm.wasm'),
					taggedWasm('swiftpm SwiftPM')
				)
			}
		});

		assert.deepEqual(result, { sourceDir, ready: true, missing: [] });
		assert.deepEqual(new Uint8Array(await readFile(path.join(sourceDir, 'sdk.tar.gz'))), sdkBytes);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('reports incomplete or invalid Swift raw runtime inputs', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-prepare-invalid-'));
	try {
		const incomplete = await prepareSwiftRawRuntime({
			sourceDir: path.join(dir, 'incomplete'),
			allowIncomplete: true
		});
		assert.deepEqual(incomplete, {
			sourceDir: path.join(dir, 'incomplete'),
			ready: false,
			missing: ['runner-worker.js', 'swiftc.wasm', 'swiftpm.wasm', 'sdk.tar.gz']
		});

		await assert.rejects(
			() => prepareSwiftRawRuntime({ sourceDir: path.join(dir, 'missing') }),
			/missing runner-worker\.js, swiftc\.wasm, swiftpm\.wasm, sdk\.tar\.gz/u
		);

		const invalidDir = path.join(dir, 'invalid');
		await writeFixtureFile(path.join(invalidDir, 'runner-worker.js'), 'self.onmessage = () => {};');
		await writeFixtureFile(path.join(invalidDir, 'swiftc.wasm'), Uint8Array.of(1, 2, 3));
		await writeFixtureFile(path.join(invalidDir, 'swiftpm.wasm'), taggedWasm('swiftpm SwiftPM'));
		await writeFixtureFile(path.join(invalidDir, 'sdk.tar.gz'), Uint8Array.of(31, 139, 8));
		await assert.rejects(
			() => prepareSwiftRawRuntime({ sourceDir: invalidDir }),
			/Swift raw runtime is not packageable/u
		);

		const zipSdkDir = path.join(dir, 'zip-sdk');
		await writeFixtureFile(path.join(zipSdkDir, 'runner-worker.js'), VALID_RUNNER_WORKER_SOURCE);
		await writeFixtureFile(path.join(zipSdkDir, 'swiftc.wasm'), taggedWasm('swiftc Swift compiler'));
		await writeFixtureFile(path.join(zipSdkDir, 'swiftpm.wasm'), taggedWasm('swiftpm SwiftPM'));
		await writeFixtureFile(path.join(zipSdkDir, 'sdk.tar.gz'), Uint8Array.of(80, 75, 3, 4));
		await assert.rejects(
			() => prepareSwiftRawRuntime({ sourceDir: zipSdkDir }),
			/SwiftWasm \.artifactbundle\.zip file/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
