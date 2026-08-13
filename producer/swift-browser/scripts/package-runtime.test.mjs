import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { packageSwiftRuntimeDist } from './package-runtime.mjs';
import {
	OFFICIAL_SWIFT_VERSION,
	OFFICIAL_WASM_SDK_CHECKSUM,
	OFFICIAL_WASM_SDK_ID,
	OFFICIAL_WASM_SDK_URL
} from './probe-toolchain.mjs';
import {
	BROWSER_BUILD_LOG_SNAPSHOT_FILE,
	SOURCE_BOOTSTRAP_RECEIPT_SNAPSHOT_FILE,
	WORKFLOW_PREFLIGHT_RECEIPT_SNAPSHOT_FILE,
	createSwiftRuntimeBuildInfo,
	EXPECTED_RUNTIME_CONTRACT,
	swiftBaselineReceiptSnapshotFile,
	validateSwiftRuntimeBuildInfo
} from './runtime-build-info.mjs';
import { validateSwiftRuntimeManifestFiles } from './runtime-manifest.mjs';

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
	self.postMessage({ progress: { percent: 1, stage: 'Loading Swift' } });
	if (!run || !baseUrl || !manifestUrl || !code || !activePath) {
		self.postMessage({ error: 'invalid Swift run message' });
		return;
	}
	const manifest = await (await fetch(manifestUrl)).json();
	const swiftcUrl = new URL('swiftc.wasm', baseUrl).href;
	const swiftpmUrl = new URL('swiftpm.wasm', baseUrl).href;
	const sdkUrl = new URL('sdk.tar.gz', baseUrl).href;
	if (stdin || args.length || workspaceFiles.length) {
		self.postMessage({ output: [manifest.runtime, swiftcUrl, swiftpmUrl, sdkUrl].join('\\n').slice(0, 0) });
	}
	self.postMessage({ results: true });
};
`;

const CONTRACT_RUNNER_WORKER_SOURCE = `
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
	self.postMessage({ progress: { percent: 1, stage: 'Loading Swift' } });
	if (!run || !baseUrl || !manifestUrl || !code || !activePath) {
		self.postMessage({ error: 'invalid Swift run message' });
		return;
	}
	const manifest = await (await fetch(manifestUrl)).json();
	const swiftc = new Uint8Array(await (await fetch(new URL('swiftc.wasm', baseUrl))).arrayBuffer());
	const swiftpm = new Uint8Array(await (await fetch(new URL('swiftpm.wasm', baseUrl))).arrayBuffer());
	const sdk = new Uint8Array(await (await fetch(new URL('sdk.tar.gz', baseUrl))).arrayBuffer());
	if (manifest.runtime !== 'Swift' || swiftc[0] !== 0 || swiftpm[0] !== 0 || sdk[0] !== 31) {
		self.postMessage({ error: 'invalid Swift runtime assets' });
		return;
	}
	if (code.includes('let =')) {
		self.postMessage({ error: 'Swift compiler failed' });
		return;
	} else if (code.includes('second = readLine()')) {
		const lines = stdin.trimEnd().split('\\n');
		self.postMessage({ output: 'swift-stdin-lines:' + lines[0] + '|' + lines[1] + '\\n' });
	} else if (code.includes('readLine')) {
		self.postMessage({ output: 'swift-stdin:' + stdin.trimEnd() + '\\n' });
	} else if (code.includes('CommandLine.arguments')) {
		self.postMessage({ output: args.join(',') + '\\n' });
	} else if (workspaceFiles.some((file) => file.path === 'Sources/Helper.swift')) {
		self.postMessage({ output: 'workspace-ok\\n' });
	} else {
		self.postMessage({ error: 'unknown Swift contract case' });
		return;
	}
	self.postMessage({ results: true });
};
`;
const VALID_SDK_ARCHIVE_BYTES = Uint8Array.from(gzipSync(Uint8Array.of(115, 100, 107)));
const VALID_SDK_ARCHIVE_SHA256 = createHash('sha256')
	.update(VALID_SDK_ARCHIVE_BYTES)
	.digest('hex');

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

async function writeFileEnsuringDir(filePath, contents) {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, contents);
}

async function writeValidSourceBundle(sourceDir, runnerWorkerSource = VALID_RUNNER_WORKER_SOURCE) {
	await writeFileEnsuringDir(path.join(sourceDir, 'runner-worker.js'), runnerWorkerSource);
	await writeFileEnsuringDir(
		path.join(sourceDir, 'swiftc.wasm'),
		taggedWasm('swiftc Swift compiler')
	);
	await writeFileEnsuringDir(
		path.join(sourceDir, 'swiftpm.wasm'),
		taggedWasm('swiftpm SwiftPM')
	);
	await writeFileEnsuringDir(
		path.join(sourceDir, 'sdk.tar.gz'),
		VALID_SDK_ARCHIVE_BYTES
	);
	await writeFileEnsuringDir(path.join(sourceDir, 'LICENSE'), 'Apache License 2.0\n');
}

test('creates and validates Swift runtime build metadata', () => {
	assert.deepEqual(
		createSwiftRuntimeBuildInfo({
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			wasmSdkUrl:
				'https://download.swift.org/swift-6.3.3-release/wasm-sdk/swift-6.3.3-RELEASE/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
			wasmSdkChecksum: 'a'.repeat(64),
			source: 'local build'
		}),
		{
			format: 'wasm-swift-runtime-build-v1',
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			wasmSdkUrl:
				'https://download.swift.org/swift-6.3.3-release/wasm-sdk/swift-6.3.3-RELEASE/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
			wasmSdkChecksum: 'a'.repeat(64),
			runtimeContract: EXPECTED_RUNTIME_CONTRACT,
			runnerWorker: 'runner-worker.js',
			compilerWasm: 'swiftc.wasm',
			packageManagerWasm: 'swiftpm.wasm',
			sdkArchive: 'sdk.tar.gz',
			source: 'local build'
		}
	);
	assert.deepEqual(
		validateSwiftRuntimeBuildInfo({
			format: 'wasm-swift-runtime-build-v1',
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			runtimeContract: EXPECTED_RUNTIME_CONTRACT,
			runnerWorker: 'runner-worker.js',
			compilerWasm: 'swiftc.wasm',
			packageManagerWasm: 'swiftpm.wasm',
			sdkArchive: 'sdk.tar.gz'
		}),
		[]
	);
	assert.deepEqual(
		validateSwiftRuntimeBuildInfo({
			format: 'wasm-swift-runtime-build-v1',
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			wasmSdkUrl: 'https://example.com/sdk.tar.gz',
			wasmSdkChecksum: 'BAD',
			runtimeContract: EXPECTED_RUNTIME_CONTRACT,
			runnerWorker: 'runner-worker.js',
			compilerWasm: 'swiftc.wasm',
			packageManagerWasm: 'swiftpm.wasm',
			sdkArchive: 'sdk.tar.gz'
		}),
		[
			'wasmSdkUrl must be a Swift.org artifact bundle HTTPS URL when provided',
			'wasmSdkChecksum must be a lowercase sha256 hex digest when provided',
			'wasmSdkUrl artifact name must match wasmSdkId'
		]
	);
	assert.deepEqual(
		validateSwiftRuntimeBuildInfo({
			format: 'wasm-swift-runtime-build-v1',
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			wasmSdkUrl:
				'https://download.swift.org/swift-6.3.3-release/wasm-sdk/swift-6.3.3-RELEASE/other_wasm.artifactbundle.tar.gz',
			runtimeContract: EXPECTED_RUNTIME_CONTRACT,
			runnerWorker: 'runner-worker.js',
			compilerWasm: 'swiftc.wasm',
			packageManagerWasm: 'swiftpm.wasm',
			sdkArchive: 'sdk.tar.gz'
		}),
		[
			'wasmSdkUrl and wasmSdkChecksum must be provided together',
			'wasmSdkUrl artifact name must match wasmSdkId'
		]
	);
});

test('packages a source bundle into the wasm-swift dist contract', async () => {
	const sourceDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-source-'));
	const distDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-dist-'));
	try {
		await writeValidSourceBundle(sourceDir);
		await writeFileEnsuringDir(path.join(sourceDir, 'build-plan.snapshot.json'), '{"format":"test"}\n');
		await writeFileEnsuringDir(path.join(sourceDir, BROWSER_BUILD_LOG_SNAPSHOT_FILE), 'browser log\n');
		await writeFileEnsuringDir(
			path.join(sourceDir, WORKFLOW_PREFLIGHT_RECEIPT_SNAPSHOT_FILE),
			'{"format":"preflight"}\n'
		);
		await writeFileEnsuringDir(
			path.join(sourceDir, SOURCE_BOOTSTRAP_RECEIPT_SNAPSHOT_FILE),
			'{"format":"bootstrap"}\n'
		);
		await writeFileEnsuringDir(
			path.join(
				sourceDir,
				swiftBaselineReceiptSnapshotFile('buildbot_linux_crosscompile_wasm')
			),
			'{"format":"receipt"}\n'
		);
		const result = await packageSwiftRuntimeDist({
			sourceDir,
			distDir,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			wasmSdkUrl:
				'https://download.swift.org/swift-6.3.3-release/wasm-sdk/swift-6.3.3-RELEASE/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
			wasmSdkChecksum: VALID_SDK_ARCHIVE_SHA256,
			source: 'unit test'
		});

		assert.equal(result.distDir, distDir);
		assert.match(result.fingerprint, /^[a-f0-9]{16}$/u);
		assert.equal(result.manifest.fingerprint, result.fingerprint);
		assert.deepEqual(await validateSwiftRuntimeManifestFiles(distDir, result.manifest), []);
		assert.deepEqual(
			(await Promise.all(
				[
					'runner-worker.js',
					'swiftc.wasm',
					'swiftpm.wasm',
					'sdk.tar.gz',
					'runtime-build.json',
					'runtime-manifest.v1.json',
					'LICENSE',
					'build-plan.snapshot.json',
					BROWSER_BUILD_LOG_SNAPSHOT_FILE,
					WORKFLOW_PREFLIGHT_RECEIPT_SNAPSHOT_FILE,
					SOURCE_BOOTSTRAP_RECEIPT_SNAPSHOT_FILE,
					swiftBaselineReceiptSnapshotFile('buildbot_linux_crosscompile_wasm')
				].map(async (relativePath) => {
					await stat(path.join(distDir, relativePath));
					return relativePath;
				})
			)).sort(),
			[
				'LICENSE',
				BROWSER_BUILD_LOG_SNAPSHOT_FILE,
				'build-plan.snapshot.json',
				'runner-worker.js',
				'runtime-build.json',
				'runtime-manifest.v1.json',
				'sdk.tar.gz',
				SOURCE_BOOTSTRAP_RECEIPT_SNAPSHOT_FILE,
				'swiftc.wasm',
				'swiftpm.wasm',
				swiftBaselineReceiptSnapshotFile('buildbot_linux_crosscompile_wasm'),
				WORKFLOW_PREFLIGHT_RECEIPT_SNAPSHOT_FILE
			]
		);
		assert.equal(await readFile(path.join(distDir, 'build-plan.snapshot.json'), 'utf8'), '{"format":"test"}\n');
		assert.equal(
			await readFile(path.join(distDir, BROWSER_BUILD_LOG_SNAPSHOT_FILE), 'utf8'),
			'browser log\n'
		);
		assert.equal(
			await readFile(path.join(distDir, WORKFLOW_PREFLIGHT_RECEIPT_SNAPSHOT_FILE), 'utf8'),
			'{"format":"preflight"}\n'
		);
		assert.equal(
			await readFile(path.join(distDir, SOURCE_BOOTSTRAP_RECEIPT_SNAPSHOT_FILE), 'utf8'),
			'{"format":"bootstrap"}\n'
		);
		assert.equal(
			await readFile(
				path.join(
					distDir,
					swiftBaselineReceiptSnapshotFile('buildbot_linux_crosscompile_wasm')
				),
				'utf8'
			),
			'{"format":"receipt"}\n'
		);
		assert.deepEqual(JSON.parse(await readFile(path.join(distDir, 'runtime-build.json'), 'utf8')), {
			format: 'wasm-swift-runtime-build-v1',
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			wasmSdkUrl:
				'https://download.swift.org/swift-6.3.3-release/wasm-sdk/swift-6.3.3-RELEASE/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
			wasmSdkChecksum: VALID_SDK_ARCHIVE_SHA256,
			runtimeContract: EXPECTED_RUNTIME_CONTRACT,
			runnerWorker: 'runner-worker.js',
			compilerWasm: 'swiftc.wasm',
			packageManagerWasm: 'swiftpm.wasm',
			sdkArchive: 'sdk.tar.gz',
			source: 'unit test'
		});
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(distDir, { recursive: true, force: true });
	}
});

test('packages a source bundle with gzip-only Swift compiler wasm assets', async () => {
	const sourceDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-source-gzip-'));
	const distDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-dist-gzip-'));
	try {
		await writeValidSourceBundle(sourceDir);
		for (const wasmFile of ['swiftc.wasm', 'swiftpm.wasm']) {
			const wasmPath = path.join(sourceDir, wasmFile);
			await writeFileEnsuringDir(`${wasmPath}.gz`, gzipSync(await readFile(wasmPath)));
			await rm(wasmPath);
		}

		const result = await packageSwiftRuntimeDist({
			sourceDir,
			distDir,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			source: 'unit test gzip-only source'
		});

		await assert.rejects(() => stat(path.join(distDir, 'swiftc.wasm')));
		await assert.rejects(() => stat(path.join(distDir, 'swiftpm.wasm')));
		await assert.doesNotReject(() => stat(path.join(distDir, 'swiftc.wasm.gz')));
		await assert.doesNotReject(() => stat(path.join(distDir, 'swiftpm.wasm.gz')));
		assert.deepEqual(result.manifest.files.map((file) => file.path).sort(), [
			'runner-worker.js',
			'sdk.tar.gz',
			'swiftc.wasm',
			'swiftpm.wasm'
		]);
		assert.deepEqual(await validateSwiftRuntimeManifestFiles(distDir, result.manifest), []);
		assert.equal(
			JSON.parse(await readFile(path.join(distDir, 'runtime-build.json'), 'utf8')).compilerWasm,
			'swiftc.wasm'
		);
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(distDir, { recursive: true, force: true });
	}
});

test('rejects official Swift Wasm SDK provenance when source sdk archive does not match', async () => {
	const sourceDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-source-'));
	const distDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-dist-'));
	try {
		await writeValidSourceBundle(sourceDir);
		await assert.rejects(
			() =>
				packageSwiftRuntimeDist({
					sourceDir,
					distDir,
					swiftVersion: OFFICIAL_SWIFT_VERSION,
					wasmSdkId: OFFICIAL_WASM_SDK_ID,
					source: 'official sdk unit test',
					officialWasmSdkProvenance: true
				}),
			/wasmSdkChecksum [a-f0-9]{64} does not match sdk\.tar\.gz sha256/u
		);
		await assert.rejects(
			() =>
				packageSwiftRuntimeDist({
					sourceDir,
					distDir,
					swiftVersion: '6.3.2',
					wasmSdkId: OFFICIAL_WASM_SDK_ID,
					source: 'bad official sdk unit test',
					officialWasmSdkProvenance: true
				}),
			/--official-wasm-sdk-provenance requires --swift-version/u
		);
		await assert.rejects(
			() =>
				packageSwiftRuntimeDist({
					sourceDir,
					distDir,
					swiftVersion: OFFICIAL_SWIFT_VERSION,
					wasmSdkId: OFFICIAL_WASM_SDK_ID,
					wasmSdkUrl: 'https://download.swift.org/other.artifactbundle.tar.gz',
					source: 'bad official sdk url unit test',
					officialWasmSdkProvenance: true
				}),
			/non-official --wasm-sdk-url/u
		);
		await assert.rejects(
			() =>
				packageSwiftRuntimeDist({
					sourceDir,
					distDir,
					swiftVersion: OFFICIAL_SWIFT_VERSION,
					wasmSdkId: OFFICIAL_WASM_SDK_ID,
					wasmSdkChecksum: '0'.repeat(64),
					source: 'bad official sdk checksum unit test',
					officialWasmSdkProvenance: true
				}),
			/non-official --wasm-sdk-checksum/u
		);
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(distDir, { recursive: true, force: true });
	}
});

test('runs the staged package through the browser contract before replacing dist when requested', async () => {
	const sourceDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-source-'));
	const distDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-dist-'));
	try {
		await writeValidSourceBundle(sourceDir, CONTRACT_RUNNER_WORKER_SOURCE);
		await writeFile(path.join(distDir, 'runtime-build.json'), '{"existing":true}\n');
		const result = await packageSwiftRuntimeDist({
			sourceDir,
			distDir,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			source: 'unit-test-contract-fixture',
			runBrowserContract: true,
			timeoutMs: 10_000
		});

		assert.match(result.fingerprint, /^[a-f0-9]{16}$/u);
		assert.match(await readFile(path.join(distDir, 'runtime-manifest.v1.json'), 'utf8'), /wasm-swift-runtime-manifest-v1/u);
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(distDir, { recursive: true, force: true });
	}
});

test('preserves an existing dist when the optional staged browser contract fails', async () => {
	const sourceDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-source-'));
	const distDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-dist-'));
	try {
		await writeValidSourceBundle(sourceDir);
		await writeFile(path.join(distDir, 'runtime-build.json'), '{"existing":true}\n');
		await writeFile(path.join(distDir, 'swiftc.wasm'), 'existing dist compiler\n');

		await assert.rejects(
			() =>
				packageSwiftRuntimeDist({
					sourceDir,
					distDir,
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					source: 'unit-test-contract-fixture',
					runBrowserContract: true,
					timeoutMs: 10_000
				}),
			/was expected to fail|stdout mismatch/u
		);
		assert.equal(await readFile(path.join(distDir, 'runtime-build.json'), 'utf8'), '{"existing":true}\n');
		assert.equal(await readFile(path.join(distDir, 'swiftc.wasm'), 'utf8'), 'existing dist compiler\n');
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(distDir, { recursive: true, force: true });
	}
});

test('requires provenance whenever packaging a Swift runtime dist', async () => {
	const sourceDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-source-'));
	const distDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-dist-'));
	try {
		await writeValidSourceBundle(sourceDir, CONTRACT_RUNNER_WORKER_SOURCE);
		await assert.rejects(
			() =>
				packageSwiftRuntimeDist({
					sourceDir,
					distDir,
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					timeoutMs: 10_000
				}),
			/source is required to package a Swift runtime dist/u
		);
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(distDir, { recursive: true, force: true });
	}
});

test('rejects invalid package metadata before writing dist files', async () => {
	const sourceDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-source-'));
	const distDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-dist-'));
	try {
		await writeValidSourceBundle(sourceDir);
		await assert.rejects(
			() =>
				packageSwiftRuntimeDist({
					sourceDir,
					distDir,
					swiftVersion: 'nightly',
					wasmSdkId: 'swift-6.3.3-RELEASE',
					source: 'unit-test-source'
				}),
			/swiftVersion must be a Swift release version string/u
		);
		await assert.rejects(() => stat(path.join(distDir, 'runtime-build.json')));
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(distDir, { recursive: true, force: true });
	}
});

test('rejects invalid browser contract timeout values', async () => {
	const sourceDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-source-'));
	const distDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-dist-'));
	try {
		await writeValidSourceBundle(sourceDir);
		await assert.rejects(
			() =>
				packageSwiftRuntimeDist({
					sourceDir,
					distDir,
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					source: 'unit-test-source',
					runBrowserContract: true,
					timeoutMs: Number.NaN
				}),
			/timeoutMs must be a positive safe integer/u
		);
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(distDir, { recursive: true, force: true });
	}
});

test('rejects destructive source and dist path combinations before removing output', async () => {
	const sourceDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-source-'));
	const parentDistDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-dist-'));
	const nestedSourceDir = path.join(parentDistDir, 'source');
	try {
		await writeValidSourceBundle(sourceDir);
		await writeValidSourceBundle(nestedSourceDir);
		await assert.rejects(
			() =>
				packageSwiftRuntimeDist({
					sourceDir,
					distDir: sourceDir,
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					source: 'unit-test-source'
				}),
			/distDir must be different from sourceDir/u
		);
		await assert.rejects(
			() =>
				packageSwiftRuntimeDist({
					sourceDir: nestedSourceDir,
					distDir: parentDistDir,
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					source: 'unit-test-source'
				}),
			/distDir must not be a parent directory of sourceDir/u
		);
		await stat(path.join(sourceDir, 'swiftc.wasm'));
		await stat(path.join(nestedSourceDir, 'swiftc.wasm'));
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(parentDistDir, { recursive: true, force: true });
	}
});

test('allows packaging into a dist directory inside the source bundle', async () => {
	const sourceDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-source-'));
	const distDir = path.join(sourceDir, 'dist');
	try {
		await writeValidSourceBundle(sourceDir);
		const result = await packageSwiftRuntimeDist({
			sourceDir,
			distDir,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			source: 'unit-test-source'
		});

		assert.equal(result.distDir, distDir);
		await stat(path.join(sourceDir, 'swiftc.wasm'));
		await stat(path.join(distDir, 'swiftc.wasm'));
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
	}
});

test('rejects packaged dist files that do not satisfy runtime signatures', async () => {
	const sourceDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-source-'));
	const distDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-dist-'));
	try {
		await writeValidSourceBundle(sourceDir);
		await writeFile(path.join(sourceDir, 'swiftc.wasm'), 'not wasm');
		await assert.rejects(
			() =>
				packageSwiftRuntimeDist({
					sourceDir,
					distDir,
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					source: 'unit-test-source'
				}),
			/swiftc\.wasm must start with the WebAssembly binary magic header/u
		);
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(distDir, { recursive: true, force: true });
	}
});

test('preserves an existing dist when source bundle preflight fails', async () => {
	const sourceDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-source-'));
	const distDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-dist-'));
	try {
		await writeValidSourceBundle(sourceDir);
		await writeFile(path.join(sourceDir, 'swiftc.wasm'), 'not wasm');
		await writeFile(path.join(distDir, 'runtime-build.json'), '{"existing":true}\n');
		await writeFile(path.join(distDir, 'swiftc.wasm'), 'existing dist compiler\n');

		await assert.rejects(
			() =>
				packageSwiftRuntimeDist({
					sourceDir,
					distDir,
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					source: 'unit-test-source'
				}),
			/Swift runtime source assets have invalid file signatures/u
		);
		assert.equal(await readFile(path.join(distDir, 'runtime-build.json'), 'utf8'), '{"existing":true}\n');
		assert.equal(await readFile(path.join(distDir, 'swiftc.wasm'), 'utf8'), 'existing dist compiler\n');
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(distDir, { recursive: true, force: true });
	}
});

test('replaces an existing dist only after a staged package is validated', async () => {
	const sourceDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-source-'));
	const distDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-dist-'));
	try {
		await writeValidSourceBundle(sourceDir);
		await writeFile(path.join(distDir, 'runtime-build.json'), '{"existing":true}\n');
		await writeFile(path.join(distDir, 'swiftc.wasm'), 'existing dist compiler\n');
		await writeFile(path.join(distDir, 'stale.txt'), 'stale\n');

		await packageSwiftRuntimeDist({
			sourceDir,
			distDir,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			source: 'unit-test-source'
		});

		assert.match(await readFile(path.join(distDir, 'runtime-build.json'), 'utf8'), /wasm-swift-runtime-build-v1/u);
		assert.deepEqual(
			[...(await readFile(path.join(distDir, 'swiftc.wasm')))],
			[...taggedWasm('swiftc Swift compiler')]
		);
		await assert.rejects(() => stat(path.join(distDir, 'stale.txt')));
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(distDir, { recursive: true, force: true });
	}
});

test('prints CLI help when package arguments are forwarded through the root script separator', async () => {
	const { spawnSync } = await import('node:child_process');
	const result = spawnSync(
		process.execPath,
		[
			path.resolve(import.meta.dirname, 'package-runtime.mjs'),
			'--',
			'--help'
		],
		{ encoding: 'utf8' }
	);

	assert.equal(result.status, 0);
	assert.match(result.stdout, /Usage: pnpm run package:wasm-swift/u);
	assert.match(result.stdout, /--source <provenance>/u);
	assert.match(result.stdout, /--wasm-sdk-url/u);
	assert.match(result.stdout, /--wasm-sdk-checksum/u);
	assert.match(result.stdout, /--official-wasm-sdk-provenance/u);
	assert.match(result.stdout, /--browser-contract/u);
	assert.match(result.stdout, /Required metadata: --source/u);
	assert.match(result.stdout, /swiftc\.wasm or swiftc\.wasm\.gz/u);
	assert.match(result.stdout, /swiftpm\.wasm or swiftpm\.wasm\.gz/u);
	assert.match(result.stdout, /manifest records logical \.wasm paths/u);
	assert.equal(result.stderr, '');
});

test('rejects invalid CLI timeout values', async () => {
	const { spawnSync } = await import('node:child_process');
	const result = spawnSync(
		process.execPath,
		[
			path.resolve(import.meta.dirname, 'package-runtime.mjs'),
			'--timeout-ms',
			'not-a-number'
		],
		{ encoding: 'utf8' }
	);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /timeoutMs must be a positive safe integer/u);
	assert.doesNotMatch(result.stderr, /\n\s+at /u);
});

test('rejects CLI options with missing values', async () => {
	const { spawnSync } = await import('node:child_process');
	const missingValue = spawnSync(
		process.execPath,
		[path.resolve(import.meta.dirname, 'package-runtime.mjs'), '--source-dir'],
		{ encoding: 'utf8' }
	);
	const nextOptionAsValue = spawnSync(
		process.execPath,
		[
			path.resolve(import.meta.dirname, 'package-runtime.mjs'),
			'--source-dir',
			'--swift-version',
			'6.3.3'
		],
		{ encoding: 'utf8' }
	);

	assert.notEqual(missingValue.status, 0);
	assert.match(missingValue.stderr, /--source-dir requires a value/u);
	assert.doesNotMatch(missingValue.stderr, /\n\s+at /u);
	assert.notEqual(nextOptionAsValue.status, 0);
	assert.match(nextOptionAsValue.stderr, /--source-dir requires a value/u);
	assert.doesNotMatch(nextOptionAsValue.stderr, /\n\s+at /u);
});

test('rejects CLI packaging without source provenance', async () => {
	const { spawnSync } = await import('node:child_process');
	const sourceDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-source-'));
	const distDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-dist-'));
	try {
		await writeValidSourceBundle(sourceDir);
		const result = spawnSync(
			process.execPath,
			[
				path.resolve(import.meta.dirname, 'package-runtime.mjs'),
				'--source-dir',
				sourceDir,
				'--dist-dir',
				distDir,
				'--swift-version',
				'6.3.3',
				'--wasm-sdk-id',
				'swift-6.3.3-RELEASE_wasm'
			],
			{ encoding: 'utf8' }
		);

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /source is required to package a Swift runtime dist/u);
		assert.doesNotMatch(result.stderr, /\n\s+at /u);
		await assert.rejects(() => stat(path.join(distDir, 'runtime-build.json')));
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(distDir, { recursive: true, force: true });
	}
});
