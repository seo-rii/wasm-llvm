import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
	packageSwiftRuntimeFromBuildPlan,
	parsePackageFromBuildPlanArgs
} from './package-from-build-plan.mjs';
import {
	OFFICIAL_SWIFT_VERSION,
	OFFICIAL_WASM_SDK_CHECKSUM,
	OFFICIAL_WASM_SDK_ID,
	OFFICIAL_WASM_SDK_URL
} from './probe-toolchain.mjs';
import {
	BROWSER_BUILD_LOG_SNAPSHOT_FILE,
	EXPECTED_RUNTIME_CONTRACT,
	SOURCE_BOOTSTRAP_RECEIPT_SNAPSHOT_FILE,
	WORKFLOW_PREFLIGHT_RECEIPT_SNAPSHOT_FILE,
	swiftBaselineReceiptSnapshotFile
} from './runtime-build-info.mjs';
import { createSwiftRuntimeContract } from './runtime-contract.mjs';

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

async function writeFixture(filePath, contents) {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, contents);
	return filePath;
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

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

test('parses Swift package-from-build-plan arguments', () => {
	assert.deepEqual(parsePackageFromBuildPlanArgs(['--help']), { help: true });
	assert.deepEqual(parsePackageFromBuildPlanArgs([]), {
		planPath: path.resolve(
			import.meta.dirname,
			'..',
			'browser-compiler-build',
			'wasm-idle-swift-browser-build-plan.json'
		),
		distDir: path.resolve(import.meta.dirname, '..', 'dist'),
		allowOfficialSdkPlaceholder: false,
		sdkUrl: OFFICIAL_WASM_SDK_URL,
		sdkChecksum: OFFICIAL_WASM_SDK_CHECKSUM,
		runBrowserContract: false,
		officialWasmSdkProvenance: false,
		requireUpstreamBaselineReceipt: false,
		requireBrowserCompilerContracts: false,
		requireBrowserBuildCommand: false,
		requireBrowserBuildExecution: false,
		requireBrowserBuildLog: false,
		requireSourceBootstrapProvenance: false
	});
	assert.deepEqual(
		parsePackageFromBuildPlanArgs([
			'--plan',
			'plan.json',
			'--dist-dir',
			'dist',
			'--swift-version',
			'6.3.3',
			'--wasm-sdk-id',
			'swift-6.3.3-RELEASE_wasm',
			'--source',
			'local build',
			'--workflow-preflight-receipt',
			'preflight.json',
			'--notes',
			'note',
			'--allow-official-sdk-placeholder',
			'--sdk-url',
			'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
			'--sdk-checksum',
			'a'.repeat(64),
			'--wasm-sdk-url',
			'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
			'--wasm-sdk-checksum',
			'b'.repeat(64),
			'--official-wasm-sdk-provenance',
			'--require-upstream-baseline-receipt',
			'--require-browser-compiler-contracts',
			'--require-browser-build-command',
			'--require-browser-build-execution',
			'--require-browser-build-log',
			'--require-source-bootstrap-provenance',
			'--browser-contract',
			'--timeout-ms',
			'1000'
		]),
		{
			planPath: path.resolve('plan.json'),
			distDir: path.resolve('dist'),
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			source: 'local build',
			workflowPreflightReceipt: path.resolve('preflight.json'),
			notes: 'note',
			allowOfficialSdkPlaceholder: true,
			sdkUrl: 'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
			sdkChecksum: 'a'.repeat(64),
			wasmSdkUrl: 'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
			wasmSdkChecksum: 'b'.repeat(64),
			officialWasmSdkProvenance: true,
			requireUpstreamBaselineReceipt: true,
			requireBrowserCompilerContracts: true,
			requireBrowserBuildCommand: true,
			requireBrowserBuildExecution: true,
			requireBrowserBuildLog: true,
			requireSourceBootstrapProvenance: true,
			runBrowserContract: true,
			timeoutMs: 1000
		}
	);
	assert.throws(() => parsePackageFromBuildPlanArgs(['--plan']), /--plan requires a value/u);
	assert.throws(() => parsePackageFromBuildPlanArgs(['--timeout-ms', '0']), /timeoutMs must/u);
	assert.throws(() => parsePackageFromBuildPlanArgs(['--unknown']), /Unknown option: --unknown/u);
});

test('verifies outputs, prepares raw runtime, and packages Swift dist from a build plan', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-package-plan-'));
	try {
		const outputsDir = path.join(dir, 'outputs');
		const rawRuntimeDir = path.join(dir, 'raw-runtime');
		const distDir = path.join(dir, 'dist');
		const planPath = path.join(dir, 'build-plan.json');
		const bootstrapReceiptPath = path.join(dir, 'source-bootstrap-receipt.json');
		const bootstrapReceipt = {
			format: 'wasm-idle-swift-source-bootstrap-receipt-v1',
			status: 'passed',
			sourceRoot: path.join(dir, 'checkout'),
			swiftRepository: 'https://github.com/swiftlang/swift.git',
			swiftRef: 'swift-6.3.3-RELEASE',
			swiftCloneDepth: 1,
			swiftCloneFilter: 'blob:none',
			dependencyScheme: 'main',
			startedAt: '2026-01-01T00:00:00.000Z',
			finishedAt: '2026-01-01T00:00:01.000Z',
			checkout: { ok: true, missing: [] }
		};
		const bootstrapReceiptBytes = Buffer.from(`${JSON.stringify(bootstrapReceipt, null, 2)}\n`);
		await writeFixture(bootstrapReceiptPath, bootstrapReceiptBytes);
		const bootstrapReceiptDigest = sha256(bootstrapReceiptBytes);
		const receiptPath = path.join(dir, 'baseline-receipt.json');
		const receiptBytes = Buffer.from(
			`${JSON.stringify(
				{
					format: 'wasm-idle-swift-upstream-baseline-build-v1',
					preset: 'buildbot_linux_crosscompile_wasm',
					status: 'passed'
				},
				null,
				2
			)}\n`
		);
		await writeFixture(receiptPath, receiptBytes);
		const receiptDigest = sha256(receiptBytes);
		const browserBuildLogPath = path.join(dir, 'browser-build.log');
		const browserBuildLogBytes = Buffer.from('browser build log\n');
		await writeFixture(browserBuildLogPath, browserBuildLogBytes);
		const browserBuildLogDigest = sha256(browserBuildLogBytes);
		const workflowPreflightReceiptPath = path.join(dir, 'workflow-preflight.json');
		const workflowPreflightReceiptBytes = Buffer.from(
			`${JSON.stringify(
				{
					format: 'wasm-idle-swift-workflow-preflight-v1',
					status: 'passed',
					sourceRoot: bootstrapReceipt.sourceRoot,
					buildDir: path.join(dir, 'build'),
					errors: []
				},
				null,
				2
			)}\n`
		);
		await writeFixture(workflowPreflightReceiptPath, workflowPreflightReceiptBytes);
		const workflowPreflightReceiptDigest = sha256(workflowPreflightReceiptBytes);
		const sdkBytes = VALID_SDK_ARCHIVE_BYTES;
		const plan = {
			format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
			checkoutRoot: bootstrapReceipt.sourceRoot,
			rawRuntimeDir,
			sourceBootstrap: {
				path: bootstrapReceiptPath,
				...bootstrapReceipt
			},
			upstreamWasmBaseline: {
				receipts: [
					{
						preset: 'buildbot_linux_crosscompile_wasm',
						path: receiptPath,
						sha256: receiptDigest,
						status: 'passed'
					}
				]
			},
			expectedOutputs: {
				'runner-worker.js': await writeFixture(
					path.join(outputsDir, 'runner-worker.js'),
					VALID_RUNNER_WORKER_SOURCE
				),
				'swiftc.wasm': await writeFixture(
					path.join(outputsDir, 'swiftc.wasm'),
					taggedWasm('swiftc Swift compiler')
				),
				'swiftpm.wasm': await writeFixture(
					path.join(outputsDir, 'swiftpm.wasm'),
					taggedWasm('swiftpm SwiftPM')
				),
				'sdk.tar.gz': 'official-swift-wasm-sdk'
			},
			browserCompilerBuild: {
				command: './build-swift-browser.sh',
				execution: {
					status: 'passed',
					command: './build-swift-browser.sh',
					cwd: bootstrapReceipt.sourceRoot,
					buildDir: path.join(dir, 'build'),
					rawRuntimeDir,
					planPath,
					logPath: browserBuildLogPath,
					startedAt: '2026-01-01T00:00:00.000Z',
					finishedAt: '2026-01-01T00:00:01.000Z',
					exitCode: 0
				},
				runtimeContract: createSwiftRuntimeContract(),
				requiredOutputs: [
					{
						name: 'runner-worker.js',
						expectedPath: path.join(outputsDir, 'runner-worker.js'),
						validation: 'validateSwiftRunnerWorkerSource'
					},
					{
						name: 'swiftc.wasm',
						expectedPath: path.join(outputsDir, 'swiftc.wasm'),
						validation: 'validateSwiftCompilerWasmModuleBytes',
						requiredIdentity: ['swift', 'swiftc']
					},
					{
						name: 'swiftpm.wasm',
						expectedPath: path.join(outputsDir, 'swiftpm.wasm'),
						validation: 'validateSwiftCompilerWasmModuleBytes',
						requiredIdentity: ['swiftpm', 'SwiftPM']
					},
					{
						name: 'sdk.tar.gz',
						expectedPath: 'official-swift-wasm-sdk',
						validation: 'validateSwiftSdkArchiveBytes'
					}
				]
			}
		};
		await writeFixture(planPath, `${JSON.stringify(plan, null, 2)}\n`);
		const planDigest = sha256(await readFile(planPath));

		const result = await packageSwiftRuntimeFromBuildPlan({
			planPath,
			distDir,
			swiftVersion: OFFICIAL_SWIFT_VERSION,
			wasmSdkId: OFFICIAL_WASM_SDK_ID,
			source: 'unit test build',
			workflowPreflightReceipt: workflowPreflightReceiptPath,
			requireUpstreamBaselineReceipt: true,
			requireBrowserCompilerContracts: true,
			requireBrowserBuildCommand: true,
			requireSourceBootstrapProvenance: true,
			allowOfficialSdkPlaceholder: true,
			sdkUrl: 'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
			sdkChecksum: sha256(sdkBytes),
			wasmSdkUrl: 'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
			wasmSdkChecksum: sha256(sdkBytes),
			fetchImpl: async () => ({
				ok: true,
				status: 200,
				arrayBuffer: async () =>
					sdkBytes.buffer.slice(sdkBytes.byteOffset, sdkBytes.byteOffset + sdkBytes.byteLength)
			})
		});

		assert.equal(result.distDir, distDir);
		assert.match(result.fingerprint, /^[a-f0-9]{16}$/u);
		for (const relativePath of [
			'runner-worker.js',
			'swiftc.wasm',
			'swiftpm.wasm',
			'sdk.tar.gz',
			'runtime-build.json',
			'runtime-manifest.v1.json',
			'build-plan.snapshot.json',
			WORKFLOW_PREFLIGHT_RECEIPT_SNAPSHOT_FILE,
			BROWSER_BUILD_LOG_SNAPSHOT_FILE,
			SOURCE_BOOTSTRAP_RECEIPT_SNAPSHOT_FILE,
			swiftBaselineReceiptSnapshotFile('buildbot_linux_crosscompile_wasm')
		]) {
			await stat(path.join(distDir, relativePath));
		}
		assert.equal(
			await readFile(path.join(distDir, 'build-plan.snapshot.json'), 'utf8'),
			await readFile(planPath, 'utf8')
		);
		assert.equal(
			await readFile(path.join(distDir, WORKFLOW_PREFLIGHT_RECEIPT_SNAPSHOT_FILE), 'utf8'),
			await readFile(workflowPreflightReceiptPath, 'utf8')
		);
		assert.equal(
			await readFile(path.join(distDir, SOURCE_BOOTSTRAP_RECEIPT_SNAPSHOT_FILE), 'utf8'),
			await readFile(bootstrapReceiptPath, 'utf8')
		);
		assert.equal(
			await readFile(path.join(distDir, BROWSER_BUILD_LOG_SNAPSHOT_FILE), 'utf8'),
			await readFile(browserBuildLogPath, 'utf8')
		);
		assert.equal(
			await readFile(
				path.join(
					distDir,
					swiftBaselineReceiptSnapshotFile('buildbot_linux_crosscompile_wasm')
				),
				'utf8'
			),
			await readFile(receiptPath, 'utf8')
		);
		assert.deepEqual(JSON.parse(await readFile(path.join(distDir, 'runtime-build.json'), 'utf8')), {
			format: 'wasm-swift-runtime-build-v1',
			swiftVersion: OFFICIAL_SWIFT_VERSION,
			wasmSdkId: OFFICIAL_WASM_SDK_ID,
			wasmSdkUrl: 'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
			wasmSdkChecksum: sha256(sdkBytes),
			runtimeContract: EXPECTED_RUNTIME_CONTRACT,
			runnerWorker: 'runner-worker.js',
			compilerWasm: 'swiftc.wasm',
			packageManagerWasm: 'swiftpm.wasm',
			sdkArchive: 'sdk.tar.gz',
			source: `unit test build; build-plan=${planPath}; build-plan-sha256=${planDigest}; source-bootstrap-receipt=${bootstrapReceiptPath}; source-bootstrap-sha256=${bootstrapReceiptDigest}; upstream-baseline-buildbot_linux_crosscompile_wasm-receipt=${receiptPath}; upstream-baseline-buildbot_linux_crosscompile_wasm-sha256=${receiptDigest}; browser-build-log=${browserBuildLogPath}; browser-build-log-sha256=${browserBuildLogDigest}; workflow-preflight-receipt=${workflowPreflightReceiptPath}; workflow-preflight-sha256=${workflowPreflightReceiptDigest}`
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects packaging from a build plan when required metadata or outputs are invalid', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-package-plan-invalid-'));
	try {
		const planPath = path.join(dir, 'build-plan.json');
		await writeFixture(
			planPath,
			`${JSON.stringify(
				{
					format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
					rawRuntimeDir: path.join(dir, 'raw-runtime'),
					expectedOutputs: {
						'runner-worker.js': path.join(dir, 'missing-worker.js'),
						'swiftc.wasm': path.join(dir, 'missing-swiftc.wasm'),
						'swiftpm.wasm': path.join(dir, 'missing-swiftpm.wasm'),
						'sdk.tar.gz': path.join(dir, 'missing-sdk.tar.gz')
					}
				},
				null,
				2
			)}\n`
		);

		await assert.rejects(
			() =>
				packageSwiftRuntimeFromBuildPlan({
					planPath,
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					source: 'unit test'
				}),
			/Swift browser build outputs are not ready/u
		);

		await writeFixture(
			planPath,
			`${JSON.stringify(
				{
					format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
					rawRuntimeDir: path.join(dir, 'raw-runtime'),
					upstreamWasmBaseline: {
						receipts: [
							{
								preset: 'buildbot_linux_crosscompile_wasm',
								path: path.join(dir, 'baseline-receipt.json'),
								sha256: 'c'.repeat(64),
								status: 'dry-run'
							}
						]
					},
					expectedOutputs: {
						'runner-worker.js': path.join(dir, 'missing-worker.js'),
						'swiftc.wasm': path.join(dir, 'missing-swiftc.wasm'),
						'swiftpm.wasm': path.join(dir, 'missing-swiftpm.wasm'),
						'sdk.tar.gz': path.join(dir, 'missing-sdk.tar.gz')
					}
				},
				null,
				2
			)}\n`
		);
		await assert.rejects(
			() =>
				packageSwiftRuntimeFromBuildPlan({
					planPath,
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					source: 'unit test'
				}),
			/receipts must have status passed/u
		);

		await writeFixture(path.join(dir, 'baseline-receipt.json'), 'tampered\n');
		await writeFixture(
			planPath,
			`${JSON.stringify(
				{
					format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
					rawRuntimeDir: path.join(dir, 'raw-runtime'),
					upstreamWasmBaseline: {
						receipts: [
							{
								preset: 'buildbot_linux_crosscompile_wasm',
								path: path.join(dir, 'baseline-receipt.json'),
								sha256: 'c'.repeat(64),
								status: 'passed'
							}
						]
					},
					expectedOutputs: {
						'runner-worker.js': path.join(dir, 'missing-worker.js'),
						'swiftc.wasm': path.join(dir, 'missing-swiftc.wasm'),
						'swiftpm.wasm': path.join(dir, 'missing-swiftpm.wasm'),
						'sdk.tar.gz': path.join(dir, 'missing-sdk.tar.gz')
					}
				},
				null,
				2
			)}\n`
		);
		await assert.rejects(
			() =>
				packageSwiftRuntimeFromBuildPlan({
					planPath,
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					source: 'unit test'
				}),
			/receipt sha256 mismatch/u
		);

		await writeFixture(
			planPath,
			`${JSON.stringify(
				{
					format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
					rawRuntimeDir: path.join(dir, 'raw-runtime'),
					expectedOutputs: {
						'runner-worker.js': path.join(dir, 'missing-worker.js'),
						'swiftc.wasm': path.join(dir, 'missing-swiftc.wasm'),
						'swiftpm.wasm': path.join(dir, 'missing-swiftpm.wasm'),
						'sdk.tar.gz': path.join(dir, 'missing-sdk.tar.gz')
					}
				},
				null,
				2
			)}\n`
		);
		await assert.rejects(
			() =>
				packageSwiftRuntimeFromBuildPlan({
					planPath,
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					source: 'unit test',
					requireUpstreamBaselineReceipt: true
				}),
			/upstreamWasmBaseline\.receipts are required/u
		);

		await assert.rejects(
			() =>
				packageSwiftRuntimeFromBuildPlan({
					planPath,
					swiftVersion: OFFICIAL_SWIFT_VERSION,
					wasmSdkId: OFFICIAL_WASM_SDK_ID,
					source: 'unit test',
					allowOfficialSdkPlaceholder: true,
					sdkUrl: 'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
					sdkChecksum: 'c'.repeat(64)
				}),
			/matching --wasm-sdk-url and --wasm-sdk-checksum provenance/u
		);

		await assert.rejects(
			() =>
				packageSwiftRuntimeFromBuildPlan({
					planPath,
					swiftVersion: OFFICIAL_SWIFT_VERSION,
					wasmSdkId: OFFICIAL_WASM_SDK_ID,
					source: 'unit test',
					allowOfficialSdkPlaceholder: true,
					sdkUrl: 'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
					sdkChecksum: 'c'.repeat(64),
					wasmSdkUrl: 'https://download.swift.org/test/other-swift-sdk.artifactbundle.tar.gz',
					wasmSdkChecksum: 'c'.repeat(64)
				}),
			/--wasm-sdk-url to match the fetched --sdk-url/u
		);

		await assert.rejects(
			() =>
				packageSwiftRuntimeFromBuildPlan({
					planPath,
					swiftVersion: OFFICIAL_SWIFT_VERSION,
					wasmSdkId: OFFICIAL_WASM_SDK_ID,
					source: 'unit test',
					allowOfficialSdkPlaceholder: true,
					sdkUrl: 'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
					sdkChecksum: 'c'.repeat(64),
					wasmSdkUrl: 'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
					wasmSdkChecksum: 'd'.repeat(64)
				}),
			/--wasm-sdk-checksum to match the fetched --sdk-checksum/u
		);

		await assert.rejects(
			() =>
				packageSwiftRuntimeFromBuildPlan({
					planPath,
					swiftVersion: OFFICIAL_SWIFT_VERSION,
					wasmSdkId: OFFICIAL_WASM_SDK_ID,
					source: 'unit test',
					allowOfficialSdkPlaceholder: true,
					sdkUrl: 'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
					sdkChecksum: 'c'.repeat(64),
					officialWasmSdkProvenance: true
				}),
			/fetched --sdk-url/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects packaging from a build plan without browser build command provenance when required', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-package-plan-command-'));
	try {
		const outputsDir = path.join(dir, 'outputs');
		const rawRuntimeDir = path.join(dir, 'raw-runtime');
		const distDir = path.join(dir, 'dist');
		const planPath = path.join(dir, 'build-plan.json');
		const expectedOutputs = {
			'runner-worker.js': await writeFixture(
				path.join(outputsDir, 'runner-worker.js'),
				VALID_RUNNER_WORKER_SOURCE
			),
			'swiftc.wasm': await writeFixture(
				path.join(outputsDir, 'swiftc.wasm'),
				taggedWasm('swiftc Swift compiler')
			),
			'swiftpm.wasm': await writeFixture(
				path.join(outputsDir, 'swiftpm.wasm'),
				taggedWasm('swiftpm SwiftPM')
			),
			'sdk.tar.gz': await writeFixture(path.join(outputsDir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES)
		};
		await writeFixture(
			planPath,
			`${JSON.stringify(
				{
					format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
					rawRuntimeDir,
					expectedOutputs,
					browserCompilerBuild: {
						runtimeContract: createSwiftRuntimeContract(),
						requiredOutputs: [
							{
								name: 'runner-worker.js',
								expectedPath: expectedOutputs['runner-worker.js'],
								validation: 'validateSwiftRunnerWorkerSource'
							},
							{
								name: 'swiftc.wasm',
								expectedPath: expectedOutputs['swiftc.wasm'],
								validation: 'validateSwiftCompilerWasmModuleBytes',
								requiredIdentity: ['swift', 'swiftc']
							},
							{
								name: 'swiftpm.wasm',
								expectedPath: expectedOutputs['swiftpm.wasm'],
								validation: 'validateSwiftCompilerWasmModuleBytes',
								requiredIdentity: ['swiftpm', 'SwiftPM']
							},
							{
								name: 'sdk.tar.gz',
								expectedPath: expectedOutputs['sdk.tar.gz'],
								validation: 'validateSwiftSdkArchiveBytes'
							}
						]
					}
				},
				null,
				2
			)}\n`
		);

		await assert.rejects(
			() =>
				packageSwiftRuntimeFromBuildPlan({
					planPath,
					distDir,
					swiftVersion: OFFICIAL_SWIFT_VERSION,
					wasmSdkId: OFFICIAL_WASM_SDK_ID,
					source: 'unit test',
					requireBrowserCompilerContracts: true,
					requireBrowserBuildCommand: true
				}),
			/browserCompilerBuild\.command is required/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects packaging from a build plan without browser build execution provenance when required', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-package-plan-execution-'));
	try {
		const outputsDir = path.join(dir, 'outputs');
		const rawRuntimeDir = path.join(dir, 'raw-runtime');
		const distDir = path.join(dir, 'dist');
		const planPath = path.join(dir, 'build-plan.json');
		const expectedOutputs = {
			'runner-worker.js': await writeFixture(
				path.join(outputsDir, 'runner-worker.js'),
				VALID_RUNNER_WORKER_SOURCE
			),
			'swiftc.wasm': await writeFixture(
				path.join(outputsDir, 'swiftc.wasm'),
				taggedWasm('swiftc Swift compiler')
			),
			'swiftpm.wasm': await writeFixture(
				path.join(outputsDir, 'swiftpm.wasm'),
				taggedWasm('swiftpm SwiftPM')
			),
			'sdk.tar.gz': await writeFixture(path.join(outputsDir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES)
		};
		await writeFixture(
			planPath,
			`${JSON.stringify(
				{
					format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
					rawRuntimeDir,
					expectedOutputs,
					browserCompilerBuild: {
						command: './build-swift-browser.sh',
						runtimeContract: createSwiftRuntimeContract(),
						requiredOutputs: [
							{
								name: 'runner-worker.js',
								expectedPath: expectedOutputs['runner-worker.js'],
								validation: 'validateSwiftRunnerWorkerSource'
							},
							{
								name: 'swiftc.wasm',
								expectedPath: expectedOutputs['swiftc.wasm'],
								validation: 'validateSwiftCompilerWasmModuleBytes',
								requiredIdentity: ['swift', 'swiftc']
							},
							{
								name: 'swiftpm.wasm',
								expectedPath: expectedOutputs['swiftpm.wasm'],
								validation: 'validateSwiftCompilerWasmModuleBytes',
								requiredIdentity: ['swiftpm', 'SwiftPM']
							},
							{
								name: 'sdk.tar.gz',
								expectedPath: expectedOutputs['sdk.tar.gz'],
								validation: 'validateSwiftSdkArchiveBytes'
							}
						]
					}
				},
				null,
				2
			)}\n`
		);

		await assert.rejects(
			() =>
				packageSwiftRuntimeFromBuildPlan({
					planPath,
					distDir,
					swiftVersion: OFFICIAL_SWIFT_VERSION,
					wasmSdkId: OFFICIAL_WASM_SDK_ID,
					source: 'unit test',
					requireBrowserCompilerContracts: true,
					requireBrowserBuildCommand: true,
					requireBrowserBuildExecution: true
				}),
			/browserCompilerBuild\.execution provenance is required/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects packaging from a build plan without source bootstrap provenance when required', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-package-plan-bootstrap-'));
	try {
		const outputsDir = path.join(dir, 'outputs');
		const rawRuntimeDir = path.join(dir, 'raw-runtime');
		const distDir = path.join(dir, 'dist');
		const planPath = path.join(dir, 'build-plan.json');
		const expectedOutputs = {
			'runner-worker.js': await writeFixture(
				path.join(outputsDir, 'runner-worker.js'),
				VALID_RUNNER_WORKER_SOURCE
			),
			'swiftc.wasm': await writeFixture(
				path.join(outputsDir, 'swiftc.wasm'),
				taggedWasm('swiftc Swift compiler')
			),
			'swiftpm.wasm': await writeFixture(
				path.join(outputsDir, 'swiftpm.wasm'),
				taggedWasm('swiftpm SwiftPM')
			),
			'sdk.tar.gz': await writeFixture(path.join(outputsDir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES)
		};
		await writeFixture(
			planPath,
			`${JSON.stringify(
				{
					format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
					rawRuntimeDir,
					expectedOutputs,
					browserCompilerBuild: {
						command: './build-swift-browser.sh',
						runtimeContract: createSwiftRuntimeContract(),
						requiredOutputs: [
							{
								name: 'runner-worker.js',
								expectedPath: expectedOutputs['runner-worker.js'],
								validation: 'validateSwiftRunnerWorkerSource'
							},
							{
								name: 'swiftc.wasm',
								expectedPath: expectedOutputs['swiftc.wasm'],
								validation: 'validateSwiftCompilerWasmModuleBytes',
								requiredIdentity: ['swift', 'swiftc']
							},
							{
								name: 'swiftpm.wasm',
								expectedPath: expectedOutputs['swiftpm.wasm'],
								validation: 'validateSwiftCompilerWasmModuleBytes',
								requiredIdentity: ['swiftpm', 'SwiftPM']
							},
							{
								name: 'sdk.tar.gz',
								expectedPath: expectedOutputs['sdk.tar.gz'],
								validation: 'validateSwiftSdkArchiveBytes'
							}
						]
					}
				},
				null,
				2
			)}\n`
		);

		await assert.rejects(
			() =>
				packageSwiftRuntimeFromBuildPlan({
					planPath,
					distDir,
					swiftVersion: OFFICIAL_SWIFT_VERSION,
					wasmSdkId: OFFICIAL_WASM_SDK_ID,
					source: 'unit test',
					requireBrowserCompilerContracts: true,
					requireBrowserBuildCommand: true,
					requireSourceBootstrapProvenance: true
				}),
			/sourceBootstrap receipt is required before packaging/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
