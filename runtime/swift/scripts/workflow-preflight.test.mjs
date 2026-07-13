import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
	checkSwiftWorkflowPreflight,
	createSwiftWorkflowPreflightReceipt,
	parseSwiftWorkflowPreflightArgs,
	writeSwiftWorkflowPreflightReceipt
} from './workflow-preflight.mjs';

const VALID_RUNNER_WORKER_SOURCE = `
self.onmessage = async (event) => {
	const { run, baseUrl, manifestUrl, code, stdin, args, activePath, workspaceFiles } = event.data || {};
	const manifest = await (await fetch(manifestUrl)).json();
	if (run || baseUrl || code || stdin || args || activePath || workspaceFiles || manifest) {
		self.postMessage({ output: 'ok', results: true, error: '', progress: { percent: 100 } });
	}
	const assets = ['swiftc.wasm', 'swiftpm.wasm', 'sdk.tar.gz'];
	self.postMessage({ output: assets.join(',') });
};
`;

function encodeU32Leb(value) {
	const bytes = [];
	let remaining = value;
	do {
		let byte = remaining & 0x7f;
		remaining >>>= 7;
		if (remaining !== 0) byte |= 0x80;
		bytes.push(byte);
	} while (remaining !== 0);
	return Uint8Array.from(bytes);
}

function taggedWasmFixture(tag) {
	const header = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
	const name = Uint8Array.from([119, 97, 115, 109, 45, 105, 100, 108, 101]);
	const nameLength = encodeU32Leb(name.byteLength);
	const tagBytes = Buffer.from(tag, 'utf8');
	const payloadLength = nameLength.byteLength + name.byteLength + tagBytes.byteLength;
	const sectionLength = encodeU32Leb(payloadLength);
	const bytes = new Uint8Array(header.byteLength + 1 + sectionLength.byteLength + payloadLength);
	let offset = 0;
	bytes.set(header, offset);
	offset += header.byteLength;
	bytes[offset] = 0;
	offset += 1;
	bytes.set(sectionLength, offset);
	offset += sectionLength.byteLength;
	bytes.set(nameLength, offset);
	offset += nameLength.byteLength;
	bytes.set(name, offset);
	offset += name.byteLength;
	bytes.set(tagBytes, offset);
	return bytes;
}

async function writeValidExplicitOutputs({ runnerWorker, swiftcWasm, swiftpmWasm, sdkArchive }) {
	await Promise.all([
		writeFile(runnerWorker, VALID_RUNNER_WORKER_SOURCE),
		writeFile(swiftcWasm, taggedWasmFixture('swiftc Swift compiler')),
		writeFile(swiftpmWasm, taggedWasmFixture('swiftpm SwiftPM')),
		writeFile(sdkArchive, gzipSync(Buffer.from('sdk')))
	]);
}

async function writeBootstrapReceipt(filePath, sourceRoot, overrides = {}) {
	await writeFile(
		filePath,
		`${JSON.stringify(
			{
				format: 'wasm-idle-swift-source-bootstrap-receipt-v1',
				status: 'passed',
				sourceRoot,
				swiftRepository: 'https://github.com/swiftlang/swift.git',
				swiftRef: 'swift-6.3.3-RELEASE',
				swiftCloneDepth: 1,
				swiftCloneFilter: 'blob:none',
				dependencyScheme: 'main',
				startedAt: '2026-01-01T00:00:00.000Z',
				finishedAt: '2026-01-01T00:00:01.000Z',
				checkout: { ok: true, missing: [] },
				...overrides
			},
			null,
			2
		)}\n`
	);
}

test('parses Swift workflow preflight arguments', () => {
	assert.deepEqual(parseSwiftWorkflowPreflightArgs(['--help']), { help: true });
	const parsed = parseSwiftWorkflowPreflightArgs([
		'--bootstrap-source',
		'true',
		'--source-root',
		'source',
		'--source-bootstrap-receipt',
		'bootstrap-receipt.json',
		'--build-dir',
		'build',
		'--min-free-gib',
		'12.5',
		'--swift-clone-depth',
		'1',
		'--swift-clone-filter',
		'blob:none',
		'--runner-worker',
		'runner-worker.js',
		'--swiftc-wasm',
		'swiftc.wasm',
		'--swiftpm-wasm',
		'swiftpm.wasm',
		'--sdk-archive',
		'sdk.tar.gz',
		'--browser-build-command',
		'./build-swift-browser.sh',
		'--swift-version',
		'6.3.3',
		'--wasm-sdk-id',
		'swift-6.3.3-RELEASE_wasm',
		'--published-url',
		'https://example.test/wasm-swift.tar.gz',
		'--receipt',
		'preflight.json'
	]);

	assert.equal(parsed.bootstrapSource, true);
	assert.equal(parsed.sourceRoot, path.resolve('source'));
	assert.equal(parsed.sourceBootstrapReceipt, path.resolve('bootstrap-receipt.json'));
	assert.equal(parsed.buildDir, path.resolve('build'));
	assert.equal(parsed.minFreeGiB, 12.5);
	assert.equal(parsed.swiftCloneDepth, '1');
	assert.equal(parsed.swiftCloneFilter, 'blob:none');
	assert.equal(parsed.runnerWorker, 'runner-worker.js');
	assert.equal(parsed.swiftcWasm, 'swiftc.wasm');
	assert.equal(parsed.swiftpmWasm, 'swiftpm.wasm');
	assert.equal(parsed.sdkArchive, 'sdk.tar.gz');
	assert.equal(parsed.browserBuildCommand, './build-swift-browser.sh');
	assert.equal(parsed.swiftVersion, '6.3.3');
	assert.equal(parsed.wasmSdkId, 'swift-6.3.3-RELEASE_wasm');
	assert.equal(parsed.publishedUrl, 'https://example.test/wasm-swift.tar.gz');
	assert.equal(parsed.receiptPath, path.resolve('preflight.json'));
	assert.throws(
		() => parseSwiftWorkflowPreflightArgs(['--bootstrap-source', 'maybe']),
		/must be true or false/u
	);
	assert.throws(
		() => parseSwiftWorkflowPreflightArgs(['--min-free-gib', '-1']),
		/non-negative/u
	);
	assert.throws(
		() => parseSwiftWorkflowPreflightArgs(['--swift-clone-depth']),
		/--swift-clone-depth requires a value/u
	);
	assert.throws(() => parseSwiftWorkflowPreflightArgs(['--unknown']), /Unknown option/u);
});

test('rejects Swift workflow inputs that would fail after expensive steps', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-workflow-preflight-'));
	try {
		const result = await checkSwiftWorkflowPreflight({
			bootstrapSource: false,
			sourceRoot: path.join(dir, 'missing-source'),
			buildDir: path.join(dir, 'build'),
			minFreeGiB: 0,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			runnerWorker: path.join(dir, 'runner-worker.js')
		});

		assert.equal(result.ok, false);
		assert.match(result.errors.join('\n'), /source-root must already exist/u);
		assert.match(result.errors.join('\n'), /source-bootstrap-receipt is required/u);
		assert.match(result.errors.join('\n'), /must be provided together/u);
		assert.match(result.errors.join('\n'), /browserCompilerBuild\.command provenance/u);
		assert.match(result.errors.join('\n'), /runner-worker file was not found/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('accepts Swift workflow inputs with a browser build command instead of explicit outputs', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-workflow-preflight-'));
	try {
		const result = await checkSwiftWorkflowPreflight({
			bootstrapSource: true,
			sourceRoot: path.join(dir, 'source'),
			buildDir: path.join(dir, 'build'),
			minFreeGiB: 0,
			swiftCloneDepth: '',
			swiftCloneFilter: '',
			browserBuildCommand: './build-swift-browser.sh',
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm'
		});

		assert.equal(result.ok, true);
		assert.deepEqual(result.errors, []);
		assert.equal(result.sourceRoot, path.join(dir, 'source'));
		assert.equal(result.buildDir, path.join(dir, 'build'));
		assert.equal(result.disk.ok, true);
		assert.equal(result.receipt.format, 'wasm-idle-swift-workflow-preflight-v1');
		assert.equal(result.receipt.status, 'passed');
		assert.equal(result.receipt.hasBrowserBuildCommand, true);
		assert.deepEqual(result.receipt.explicitOutputPaths, {});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('writes Swift workflow preflight receipts for failed diagnostics', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-workflow-preflight-receipt-'));
	try {
		const receiptPath = path.join(dir, 'nested', 'preflight.json');
		const receipt = createSwiftWorkflowPreflightReceipt(
			{
				bootstrapSource: false,
				sourceRoot: path.join(dir, 'missing-source'),
				sourceBootstrapReceipt: path.join(dir, 'bootstrap.json'),
				buildDir: path.join(dir, 'build'),
				minFreeGiB: 0,
				runnerWorker: path.join(dir, 'runner-worker.js'),
				swiftVersion: '6.3.3',
				wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
				publishedUrl: 'https://example.test/wasm-swift.tar.gz'
			},
			['source-root missing'],
			{ ok: true, probePath: dir, freeBytes: 1_000_000, minFreeGiB: 0 }
		);
		const writtenPath = await writeSwiftWorkflowPreflightReceipt(receiptPath, receipt);
		const parsed = JSON.parse(await readFile(receiptPath, 'utf8'));

		assert.equal(writtenPath, receiptPath);
		assert.equal(parsed.format, 'wasm-idle-swift-workflow-preflight-v1');
		assert.equal(parsed.status, 'failed');
		assert.equal(parsed.bootstrapSource, false);
		assert.equal(parsed.sourceBootstrapReceipt, path.join(dir, 'bootstrap.json'));
		assert.equal(parsed.explicitOutputPaths.runnerWorker, path.join(dir, 'runner-worker.js'));
		assert.equal(parsed.swiftVersion, '6.3.3');
		assert.equal(parsed.wasmSdkId, 'swift-6.3.3-RELEASE_wasm');
		assert.equal(parsed.publishedUrl, 'https://example.test/wasm-swift.tar.gz');
		assert.deepEqual(parsed.errors, ['source-root missing']);
		assert.match(parsed.checkedAt, /^\d{4}-\d{2}-\d{2}T/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects baseline-only Swift presets as workflow browser build commands', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-workflow-preflight-command-'));
	try {
		const result = await checkSwiftWorkflowPreflight({
			bootstrapSource: true,
			sourceRoot: path.join(dir, 'source'),
			buildDir: path.join(dir, 'build'),
			minFreeGiB: 0,
			browserBuildCommand: 'swift/utils/build-script --preset buildbot_linux_crosscompile_wasm',
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm'
		});

		assert.equal(result.ok, false);
		assert.match(
			result.errors.join('\n'),
			/native Swift\/WASI baseline preset, not a browser compiler build command/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects no-op Swift workflow browser build commands', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-workflow-preflight-noop-command-'));
	try {
		const result = await checkSwiftWorkflowPreflight({
			bootstrapSource: true,
			sourceRoot: path.join(dir, 'source'),
			buildDir: path.join(dir, 'build'),
			minFreeGiB: 0,
			browserBuildCommand: 'true',
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm'
		});

		assert.equal(result.ok, false);
		assert.match(result.errors.join('\n'), /no-op\/documentation commands are not accepted/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('validates Swift workflow clone options before source bootstrap', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-workflow-preflight-clone-'));
	try {
		const accepted = await checkSwiftWorkflowPreflight({
			bootstrapSource: true,
			sourceRoot: path.join(dir, 'source'),
			buildDir: path.join(dir, 'build'),
			minFreeGiB: 0,
			swiftCloneDepth: '1',
			swiftCloneFilter: 'blob:none',
			browserBuildCommand: './build-swift-browser.sh',
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm'
		});
		assert.equal(accepted.ok, true);

		const invalid = await checkSwiftWorkflowPreflight({
			bootstrapSource: true,
			sourceRoot: path.join(dir, 'source'),
			buildDir: path.join(dir, 'build'),
			minFreeGiB: 0,
			swiftCloneDepth: '0',
			swiftCloneFilter: '../bad',
			browserBuildCommand: './build-swift-browser.sh',
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm'
		});
		assert.equal(invalid.ok, false);
		assert.match(invalid.errors.join('\n'), /swift-clone-depth must be a positive integer/u);
		assert.match(invalid.errors.join('\n'), /swift-clone-filter must be a non-empty/u);

		const sourceRoot = path.join(dir, 'existing-source');
		const bootstrapReceipt = path.join(dir, 'bootstrap-receipt.json');
		await mkdir(sourceRoot, { recursive: true });
		await writeBootstrapReceipt(bootstrapReceipt, sourceRoot);
		const unused = await checkSwiftWorkflowPreflight({
			bootstrapSource: false,
			sourceRoot,
			sourceBootstrapReceipt: bootstrapReceipt,
			buildDir: path.join(dir, 'build'),
			minFreeGiB: 0,
			swiftCloneDepth: '1',
			swiftCloneFilter: 'blob:none',
			browserBuildCommand: './build-swift-browser.sh',
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm'
		});
		assert.equal(unused.ok, false);
		assert.match(unused.errors.join('\n'), /swift-clone-depth can only be used/u);
		assert.match(unused.errors.join('\n'), /swift-clone-filter can only be used/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects existing-checkout workflow inputs with an invalid source bootstrap receipt', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-workflow-preflight-receipt-'));
	try {
		const sourceRoot = path.join(dir, 'source');
		const bootstrapReceipt = path.join(dir, 'bootstrap-receipt.json');
		await mkdir(sourceRoot, { recursive: true });
		await writeBootstrapReceipt(bootstrapReceipt, path.join(dir, 'other-source'), {
			status: 'failed'
		});

		const result = await checkSwiftWorkflowPreflight({
			bootstrapSource: false,
			sourceRoot,
			sourceBootstrapReceipt: bootstrapReceipt,
			buildDir: path.join(dir, 'build'),
			minFreeGiB: 0,
			browserBuildCommand: './build-swift-browser.sh',
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm'
		});

		assert.equal(result.ok, false);
		assert.match(result.errors.join('\n'), /source-bootstrap-receipt is invalid/u);
		assert.match(result.errors.join('\n'), /status must be passed/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects Swift workflow inputs when build workspace disk space is too small', async () => {
	const result = await checkSwiftWorkflowPreflight({
		bootstrapSource: true,
		sourceRoot: '/tmp/source',
		buildDir: '/tmp/build',
		minFreeGiB: 80,
		browserBuildCommand: './build-swift-browser.sh',
		swiftVersion: '6.3.3',
		wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
		inspectDiskSpace: async () => ({
			probePath: '/tmp',
			freeBytes: 2 * 1024 * 1024 * 1024,
			requiredFreeBytes: 80 * 1024 * 1024 * 1024,
			minFreeGiB: 80,
			ok: false
		})
	});

	assert.equal(result.ok, false);
	assert.match(result.errors.join('\n'), /build-dir does not have enough free space/u);
	assert.equal(result.disk.ok, false);
});

test('rejects Swift workflow inputs with explicit compiler outputs but no build command provenance', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-workflow-preflight-'));
	try {
		const sourceRoot = path.join(dir, 'source');
		const bootstrapReceipt = path.join(dir, 'bootstrap-receipt.json');
		await mkdir(sourceRoot, { recursive: true });
		await writeBootstrapReceipt(bootstrapReceipt, sourceRoot);
		const runnerWorker = path.join(dir, 'runner-worker.js');
		const swiftcWasm = path.join(dir, 'swiftc.wasm');
		const swiftpmWasm = path.join(dir, 'swiftpm.wasm');
		const sdkArchive = path.join(dir, 'sdk.tar.gz');
		await Promise.all([
			writeFile(runnerWorker, ''),
			writeFile(swiftcWasm, ''),
			writeFile(swiftpmWasm, ''),
			writeFile(sdkArchive, '')
		]);

		const result = await checkSwiftWorkflowPreflight({
			bootstrapSource: false,
			sourceRoot,
			sourceBootstrapReceipt: bootstrapReceipt,
			buildDir: path.join(dir, 'build'),
			minFreeGiB: 0,
			runnerWorker,
			swiftcWasm,
			swiftpmWasm,
			sdkArchive,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			publishedUrl: 'https://example.test/wasm-swift.tar.gz'
		});

		assert.equal(result.ok, false);
		assert.match(result.errors.join('\n'), /browserCompilerBuild\.command provenance/u);
		assert.match(result.errors.join('\n'), /runner-worker is invalid/u);
		assert.match(result.errors.join('\n'), /swiftc-wasm is invalid/u);
		assert.match(result.errors.join('\n'), /swiftpm-wasm is invalid/u);
		assert.match(result.errors.join('\n'), /sdk-archive is invalid/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('accepts Swift workflow inputs with explicit compiler outputs and build command provenance', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-workflow-preflight-'));
	try {
		const sourceRoot = path.join(dir, 'source');
		const bootstrapReceipt = path.join(dir, 'bootstrap-receipt.json');
		await mkdir(sourceRoot, { recursive: true });
		await writeBootstrapReceipt(bootstrapReceipt, sourceRoot);
		const runnerWorker = path.join(dir, 'runner-worker.js');
		const swiftcWasm = path.join(dir, 'swiftc.wasm');
		const swiftpmWasm = path.join(dir, 'swiftpm.wasm');
		const sdkArchive = path.join(dir, 'sdk.tar.gz');
		await writeValidExplicitOutputs({ runnerWorker, swiftcWasm, swiftpmWasm, sdkArchive });

		const result = await checkSwiftWorkflowPreflight({
			bootstrapSource: false,
			sourceRoot,
			sourceBootstrapReceipt: bootstrapReceipt,
			buildDir: path.join(dir, 'build'),
			minFreeGiB: 0,
			runnerWorker,
			swiftcWasm,
			swiftpmWasm,
			sdkArchive,
			browserBuildCommand: './build-swift-browser.sh',
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			publishedUrl: 'https://example.test/wasm-swift.tar.gz'
		});

		assert.equal(result.ok, true);
		assert.deepEqual(result.errors, []);
		assert.equal(result.sourceRoot, sourceRoot);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects Swift workflow metadata that would not pass runtime readiness later', async () => {
	const result = await checkSwiftWorkflowPreflight({
		bootstrapSource: true,
		sourceRoot: '/tmp/source',
		minFreeGiB: 0,
		swiftVersion: 'swift-6.3',
		wasmSdkId: 'swift-6.3.3-RELEASE_embedded',
		publishedUrl: 'file:///tmp/wasm-swift.tar.gz'
	});

	assert.equal(result.ok, false);
	assert.match(result.errors.join('\n'), /swift-version/u);
	assert.match(result.errors.join('\n'), /ending in _wasm/u);
	assert.match(result.errors.join('\n'), /published-url must be http\(s\)/u);
});
