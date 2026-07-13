import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
	buildSwiftDoctorNextActions,
	formatSwiftDoctorReport,
	parseSwiftDoctorArgs,
	runSwiftDoctor
} from './doctor.mjs';
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

async function writeFixture(filePath, contents) {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, contents);
	return filePath;
}

async function writeBuildPlan(planPath, buildDir, overrides = {}) {
	const plan = {
		format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
		rawRuntimeDir: path.join(path.dirname(planPath), 'raw-runtime'),
		expectedOutputs: {
			'runner-worker.js': path.join(buildDir, 'runner-worker.js'),
			'swiftc.wasm': path.join(buildDir, 'swiftc.wasm'),
			'swiftpm.wasm': path.join(buildDir, 'swiftpm.wasm'),
			'sdk.tar.gz': path.join(buildDir, 'sdk.tar.gz')
		},
		browserCompilerBuild: {
			command: './build-swift-browser.sh',
			runtimeContract: createSwiftRuntimeContract(),
			requiredOutputs: [
				{
					name: 'runner-worker.js',
					expectedPath: path.join(buildDir, 'runner-worker.js'),
					validation: 'validateSwiftRunnerWorkerSource'
				},
				{
					name: 'swiftc.wasm',
					expectedPath: path.join(buildDir, 'swiftc.wasm'),
					validation: 'validateSwiftCompilerWasmModuleBytes',
					requiredIdentity: ['swift', 'swiftc']
				},
				{
					name: 'swiftpm.wasm',
					expectedPath: path.join(buildDir, 'swiftpm.wasm'),
					validation: 'validateSwiftCompilerWasmModuleBytes',
					requiredIdentity: ['swiftpm', 'SwiftPM']
				},
				{
					name: 'sdk.tar.gz',
					expectedPath: path.join(buildDir, 'sdk.tar.gz'),
					validation: 'validateSwiftSdkArchiveBytes'
				}
			]
		},
		...overrides
	};
	await writeFixture(planPath, `${JSON.stringify(plan, null, 2)}\n`);
	return plan;
}

test('parses Swift doctor arguments', () => {
	assert.deepEqual(parseSwiftDoctorArgs(['--help']), { help: true });
	assert.deepEqual(
		parseSwiftDoctorArgs([
			'--build-dir',
			'build',
			'--bundle-dir',
			'bundle',
			'--plan',
			'plan.json',
			'--upstream-api-url',
			'https://example.com/swift-release.json',
			'--allow-official-sdk-placeholder',
			'--require-registered',
			'--require-build-plan-provenance',
			'--require-source-bootstrap-provenance',
			'--require-browser-build-command-provenance',
			'--require-browser-build-execution-provenance',
			'--require-browser-build-log-provenance',
			'--require-upstream-baseline-provenance',
			'--require-compressed-manifest',
			'--require-browser-compiler-contracts',
			'--browser-contract',
			'--probe-toolchain',
			'--probe-toolchain-run-wasm',
			'--min-free-gib',
			'96',
			'--timeout-ms',
			'120000',
			'--upstream-receipt',
			'out/swift-upstream-discovery.json',
			'--json'
		]),
		{
			buildDir: path.resolve('build'),
			bundleDir: path.resolve('bundle'),
			planPath: path.resolve('plan.json'),
			upstreamApiUrl: 'https://example.com/swift-release.json',
			skipUpstream: false,
			allowOfficialSdkPlaceholder: true,
			requireRegistered: true,
			requireBuildPlanProvenance: true,
			requireSourceBootstrapProvenance: true,
			requireBrowserBuildCommandProvenance: true,
			requireBrowserBuildExecutionProvenance: true,
			requireBrowserBuildLogProvenance: true,
			requireBaselineProvenance: true,
			requireCompressedManifest: true,
			requireBrowserCompilerContracts: true,
			runBrowserContract: true,
			probeToolchain: true,
			probeToolchainRunWasm: true,
			minFreeGiB: 96,
			timeoutMs: 120000,
			upstreamReceiptPath: path.resolve('out/swift-upstream-discovery.json'),
			json: true
		}
	);
	assert.throws(() => parseSwiftDoctorArgs(['--build-dir']), /--build-dir requires a value/u);
	assert.throws(
		() => parseSwiftDoctorArgs(['--upstream-api-url']),
		/--upstream-api-url requires a value/u
	);
	assert.throws(
		() => parseSwiftDoctorArgs(['--upstream-api-url', 'file:///tmp/release.json']),
		/--upstream-api-url must be an HTTP\(S\) URL/u
	);
	assert.throws(
		() => parseSwiftDoctorArgs(['--upstream-receipt']),
		/--upstream-receipt requires a value/u
	);
	assert.throws(
		() =>
			parseSwiftDoctorArgs([
				'--skip-upstream',
				'--upstream-api-url',
				'https://example.com/swift-release.json'
			]),
		/--upstream-api-url cannot be used with --skip-upstream/u
	);
	assert.throws(
		() =>
			parseSwiftDoctorArgs([
				'--skip-upstream',
				'--upstream-receipt',
				'out/swift-upstream-discovery.json'
			]),
		/--upstream-receipt cannot be used with --skip-upstream/u
	);
	assert.throws(() => parseSwiftDoctorArgs(['--timeout-ms', '0']), /timeoutMs/u);
	assert.throws(() => parseSwiftDoctorArgs(['--min-free-gib', '-1']), /non-negative/u);
	assert.throws(() => parseSwiftDoctorArgs(['--unknown']), /Unknown option/u);
});

test('rejects non-HTTP Swift doctor upstream API URLs before discovery', async () => {
	await assert.rejects(
		() => runSwiftDoctor({ upstreamApiUrl: 'ftp://example.com/release.json' }),
		/upstreamApiUrl must be an HTTP\(S\) URL/u
	);
});

test('rejects Swift doctor upstream receipts when upstream discovery is skipped', async () => {
	await assert.rejects(
		() =>
			runSwiftDoctor({
				skipUpstream: true,
				upstreamReceiptPath: path.resolve('out/swift-upstream-discovery.json')
			}),
		/--upstream-receipt cannot be used with --skip-upstream/u
	);
});

test('rejects Swift doctor upstream API URL overrides when upstream discovery is skipped', async () => {
	await assert.rejects(
		() =>
			runSwiftDoctor({
				skipUpstream: true,
				upstreamApiUrl: 'https://example.com/swift-release.json'
			}),
		/--upstream-api-url cannot be used with --skip-upstream/u
	);
});

test('reports current blockers without requiring network', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-doctor-missing-'));
	try {
		const report = await runSwiftDoctor({
			skipUpstream: true,
			buildDir: path.join(dir, 'build'),
			bundleDir: path.join(dir, 'bundle'),
			inspectDiskSpace: async (targetDir, { minFreeGiB }) => ({
				probePath: dir,
				freeBytes: 7 * 1024 * 1024 * 1024,
				requiredFreeBytes: minFreeGiB * 1024 * 1024 * 1024,
				minFreeGiB,
				ok: false
			})
		});
		assert.equal(report.ready, false);
		assert.equal(report.disk.ok, false);
		assert.equal(report.disk.minFreeGiB, 80);
		assert.equal(report.toolchain.checked, false);
		assert.equal(report.upstream.checked, false);
		assert.equal(report.buildOutputs.ready, false);
		assert.match(report.buildOutputs.error, /build directory was not found/u);
		assert.equal(report.buildPlan.valid, false);
		assert.ok(
			report.buildPlan.errors.some((error) =>
				/Swift browser build plan could not be read/u.test(error)
			)
		);
		assert.equal(report.readiness.ready, false);
		assert.ok(
			report.readiness.errors.some((error) =>
				/Swift browser runtime bundle directory was not found/u.test(error)
			)
		);
		assert.ok(report.nextActions.some((action) => /without --skip-upstream/u.test(action)));
		assert.ok(report.nextActions.some((action) => /probe:toolchain/u.test(action)));
		assert.ok(report.nextActions.some((action) => /probe:install/u.test(action)));
		assert.ok(report.nextActions.some((action) => /larger Swift build workspace/u.test(action)));
		assert.ok(report.nextActions.some((action) => /--source-root \/path\/to\/large-disk/u.test(action)));
		assert.ok(report.nextActions.some((action) => /package-sync:wasm-swift-from-plan:strict/u.test(action)));
		assert.ok(report.nextActions.some((action) => /bootstrap:wasm-swift-source/u.test(action)));
		assert.ok(report.nextActions.some((action) => /browser_build_command/u.test(action)));
		assert.ok(report.nextActions.some((action) => /discover:wasm-swift-build-outputs/u.test(action)));
		assert.ok(report.nextActions.some((action) => /run:wasm-swift-upstream-baseline/u.test(action)));
		assert.match(formatSwiftDoctorReport(report), /Swift runtime doctor/u);
		assert.match(formatSwiftDoctorReport(report), /Disk:[\s\S]*large Swift builds: no/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('can include the native Swift toolchain probe in the doctor report', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-doctor-toolchain-'));
	try {
		const report = await runSwiftDoctor({
			skipUpstream: true,
			probeToolchain: true,
			probeToolchainRunWasm: true,
			buildDir: path.join(dir, 'build'),
			bundleDir: path.join(dir, 'bundle'),
			toolchainProbe: async ({ runWasm }) => ({
				hostSwift: 'Swift version 6.3.3',
				selectedSdk: 'swift-6.3.3-RELEASE_wasm',
				wasmBytes: 12345,
				...(runWasm ? { runStdout: 'swift-stdin:hello wasm-idle\n' } : {})
			})
		});
		const formatted = formatSwiftDoctorReport(report);

		assert.equal(report.toolchain.checked, true);
		assert.equal(report.toolchain.ok, true);
		assert.equal(report.toolchain.runWasm, true);
		assert.equal(report.toolchain.hostSwift, 'Swift version 6.3.3');
		assert.equal(report.toolchain.selectedSdk, 'swift-6.3.3-RELEASE_wasm');
		assert.equal(report.toolchain.wasmBytes, 12345);
		assert.equal(report.toolchain.runStdout, 'swift-stdin:hello wasm-idle\n');
		assert.match(formatted, /Toolchain:/u);
		assert.match(formatted, /host Swift: Swift version 6\.3\.3/u);
		assert.match(formatted, /run stdout: "swift-stdin:hello wasm-idle\\n"/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('reports native Swift toolchain probe failures without blocking other doctor checks', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-doctor-toolchain-fail-'));
	try {
		const report = await runSwiftDoctor({
			skipUpstream: true,
			probeToolchain: true,
			buildDir: path.join(dir, 'build'),
			bundleDir: path.join(dir, 'bundle'),
			toolchainProbe: async () => {
				throw new Error('Swift toolchain is not available');
			}
		});
		const formatted = formatSwiftDoctorReport(report);

		assert.equal(report.toolchain.checked, true);
		assert.equal(report.toolchain.ok, false);
		assert.equal(report.toolchain.error, 'Swift toolchain is not available');
		assert.equal(report.upstream.checked, false);
		assert.equal(report.buildOutputs.ready, false);
		assert.match(formatted, /Toolchain:[\s\S]*ready: no/u);
		assert.match(formatted, /error: Swift toolchain is not available/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('summarizes upstream SDK-only releases and local build outputs', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-doctor-build-'));
	try {
		const buildDir = path.join(dir, 'build');
		await writeFixture(path.join(buildDir, 'runner-worker.js'), VALID_RUNNER_WORKER_SOURCE);
		await writeFixture(
			path.join(buildDir, 'swiftc.wasm'),
			taggedWasm('swiftc Swift compiler')
		);
		await writeFixture(
			path.join(buildDir, 'swiftpm.wasm'),
			taggedWasm('swiftpm SwiftPM')
		);
		await writeFixture(path.join(buildDir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES);
		const planPath = path.join(dir, 'plan.json');
		const upstreamReceiptPath = path.join(dir, 'upstream-discovery.json');
		const upstreamApiUrl = 'https://example.com/custom-swift-release.json';
		const requestedUrls = [];
		await writeBuildPlan(planPath, buildDir);

		const report = await runSwiftDoctor({
			buildDir,
			bundleDir: path.join(dir, 'bundle'),
			planPath,
			upstreamApiUrl,
			upstreamReceiptPath,
			requireBrowserCompilerContracts: true,
			fetchImpl: async (url) => {
				requestedUrls.push(url);
				return {
					ok: true,
					status: 200,
					json: async () => ({
						tag_name: 'swift-wasm-6.3-RELEASE',
						assets: [
							{
								name: 'swift-6.3-RELEASE_wasm.artifactbundle.zip',
								size: 123,
								browser_download_url: 'https://example.com/sdk.zip'
							},
							{
								name: 'swift-6.3-RELEASE_wasm.artifactbundle.zip.sha256',
								size: 64,
								browser_download_url: 'https://example.com/sdk.zip.sha256'
							},
							{
								name: 'swift-6.3-RELEASE_macos.artifactbundle.zip',
								size: 456,
								browser_download_url: 'https://example.com/native-sdk.zip'
							}
						]
					})
				};
			}
		});

		assert.deepEqual(requestedUrls, [upstreamApiUrl]);
		assert.equal(report.ready, false);
		assert.equal(report.upstream.checked, true);
		assert.equal(report.upstream.apiUrl, upstreamApiUrl);
		assert.equal(report.upstream.ok, true);
		assert.equal(report.upstream.receiptPath, upstreamReceiptPath);
		assert.equal(report.upstream.hasBrowserCompilerBundle, false);
		assert.deepEqual(
			report.upstream.sdkArtifacts.map((asset) => asset.checksumAsset?.name),
			['swift-6.3-RELEASE_wasm.artifactbundle.zip.sha256']
		);
		assert.deepEqual(report.upstream.sdkArtifactsMissingChecksums, []);
		assert.deepEqual(
			report.upstream.sdkArtifactsNotGzip.map((asset) => asset.name),
			['swift-6.3-RELEASE_wasm.artifactbundle.zip']
		);
		assert.deepEqual(
			report.upstream.ignoredArtifactBundles.map((asset) => asset.name),
			['swift-6.3-RELEASE_macos.artifactbundle.zip']
		);
		assert.equal(report.buildOutputs.ready, true);
		assert.equal(report.buildPlan.valid, true);
		assert.equal(report.buildPlan.hasBrowserCompilerContracts, true);
		assert.equal(report.readiness.ready, false);
		assert.ok(
			report.nextActions.some((action) => /upstream currently exposes SDK artifacts/u.test(action))
		);
		assert.ok(
			report.nextActions.some((action) => /package-sync:wasm-swift-from-plan/u.test(action))
		);
		assert.ok(
			report.nextActions.some((action) => /zip artifactbundles directly to sdk\.tar\.gz/u.test(action))
		);
		const receipt = JSON.parse(await readFile(upstreamReceiptPath, 'utf8'));
		assert.equal(receipt.format, 'wasm-idle-swift-upstream-discovery-v1');
		assert.equal(receipt.status, 'sdk-only');
		assert.equal(receipt.apiUrl, upstreamApiUrl);
		assert.deepEqual(receipt.sdkArtifacts.map((asset) => asset.name), [
			'swift-6.3-RELEASE_wasm.artifactbundle.zip'
		]);
		const formatted = formatSwiftDoctorReport(report);
		assert.match(formatted, /api: https:\/\/example\.com\/custom-swift-release\.json/u);
		assert.match(formatted, /receipt: .*upstream-discovery\.json/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('reports upstream discovery failures without claiming sdk-only upstream status', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-doctor-upstream-failure-'));
	try {
		const report = await runSwiftDoctor({
			buildDir: path.join(dir, 'build'),
			bundleDir: path.join(dir, 'bundle'),
			upstreamApiUrl: 'https://example.com/swift-release.json',
			fetchImpl: async () => ({
				ok: false,
				status: 403
			})
		});
		const formatted = formatSwiftDoctorReport(report);

		assert.equal(report.ready, false);
		assert.equal(report.upstream.checked, true);
		assert.equal(report.upstream.ok, false);
		assert.equal(report.upstream.error, 'Swift upstream release discovery failed: HTTP 403');
		assert.equal(report.buildOutputs.ready, false);
		assert.equal(report.readiness.ready, false);
		assert.ok(report.nextActions.some((action) => /Fix Swift upstream discovery/u.test(action)));
		assert.ok(
			!report.nextActions.some((action) =>
				/upstream currently exposes SDK artifacts/u.test(action)
			)
		);
		assert.match(formatted, /api: https:\/\/example\.com\/swift-release\.json/u);
		assert.match(formatted, /error: Swift upstream release discovery failed: HTTP 403/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('reports stale Swift browser build plans without output contracts', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-doctor-plan-contracts-'));
	try {
		const buildDir = path.join(dir, 'build');
		await writeFixture(path.join(buildDir, 'runner-worker.js'), VALID_RUNNER_WORKER_SOURCE);
		await writeFixture(
			path.join(buildDir, 'swiftc.wasm'),
			taggedWasm('swiftc Swift compiler')
		);
		await writeFixture(
			path.join(buildDir, 'swiftpm.wasm'),
			taggedWasm('swiftpm SwiftPM')
		);
		await writeFixture(path.join(buildDir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES);
		const planPath = path.join(dir, 'plan.json');
		await writeBuildPlan(planPath, buildDir, { browserCompilerBuild: undefined });

		const report = await runSwiftDoctor({
			skipUpstream: true,
			buildDir,
			bundleDir: path.join(dir, 'bundle'),
			planPath,
			requireBrowserCompilerContracts: true
		});
		const formatted = formatSwiftDoctorReport(report);

		assert.equal(report.buildOutputs.ready, true);
		assert.equal(report.buildPlan.valid, false);
		assert.equal(report.buildPlan.hasBrowserCompilerContracts, false);
		assert.ok(
			report.buildPlan.errors.some((error) =>
				/browserCompilerBuild\.requiredOutputs must be an array/u.test(error)
			)
		);
		assert.match(formatted, /Build plan:/u);
		assert.match(formatted, /browser compiler contracts: no/u);
		assert.ok(
			report.nextActions.some((action) => /--require-browser-compiler-contracts/u.test(action))
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('reports Swift browser build plans without build command provenance when required', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-doctor-plan-command-'));
	try {
		const buildDir = path.join(dir, 'build');
		await writeFixture(path.join(buildDir, 'runner-worker.js'), VALID_RUNNER_WORKER_SOURCE);
		await writeFixture(
			path.join(buildDir, 'swiftc.wasm'),
			taggedWasm('swiftc Swift compiler')
		);
		await writeFixture(
			path.join(buildDir, 'swiftpm.wasm'),
			taggedWasm('swiftpm SwiftPM')
		);
		await writeFixture(path.join(buildDir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES);
		const planPath = path.join(dir, 'plan.json');
		await writeBuildPlan(planPath, buildDir, {
			browserCompilerBuild: {
				runtimeContract: createSwiftRuntimeContract(),
				requiredOutputs: [
					{
						name: 'runner-worker.js',
						expectedPath: path.join(buildDir, 'runner-worker.js'),
						validation: 'validateSwiftRunnerWorkerSource'
					},
					{
						name: 'swiftc.wasm',
						expectedPath: path.join(buildDir, 'swiftc.wasm'),
						validation: 'validateSwiftCompilerWasmModuleBytes',
						requiredIdentity: ['swift', 'swiftc']
					},
					{
						name: 'swiftpm.wasm',
						expectedPath: path.join(buildDir, 'swiftpm.wasm'),
						validation: 'validateSwiftCompilerWasmModuleBytes',
						requiredIdentity: ['swiftpm', 'SwiftPM']
					},
					{
						name: 'sdk.tar.gz',
						expectedPath: path.join(buildDir, 'sdk.tar.gz'),
						validation: 'validateSwiftSdkArchiveBytes'
					}
				]
			}
		});

		const report = await runSwiftDoctor({
			skipUpstream: true,
			buildDir,
			bundleDir: path.join(dir, 'bundle'),
			planPath,
			requireBrowserCompilerContracts: true,
			requireBrowserBuildCommandProvenance: true
		});
		const formatted = formatSwiftDoctorReport(report);

		assert.equal(report.buildOutputs.ready, true);
		assert.equal(report.buildPlan.valid, false);
		assert.ok(
			report.buildPlan.errors.some((error) =>
				/browserCompilerBuild\.command is required/u.test(error)
			)
		);
		assert.match(formatted, /browserCompilerBuild\.command is required/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('reports Swift browser build candidate validation errors in doctor output', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-doctor-validation-errors-'));
	try {
		const buildDir = path.join(dir, 'build');
		await writeFixture(path.join(buildDir, 'runner-worker.js'), VALID_RUNNER_WORKER_SOURCE);
		await writeFixture(
			path.join(buildDir, 'swiftc.wasm'),
			Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)
		);
		await writeFixture(
			path.join(buildDir, 'swiftpm.wasm'),
			taggedWasm('swiftpm SwiftPM')
		);
		await writeFixture(path.join(buildDir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES);

		const report = await runSwiftDoctor({
			skipUpstream: true,
			buildDir,
			bundleDir: path.join(dir, 'bundle')
		});
		const formatted = formatSwiftDoctorReport(report);

		assert.equal(report.buildOutputs.ready, false);
		assert.deepEqual(report.buildOutputs.missing, ['swiftc.wasm']);
		assert.match(formatted, /validation error: swiftc\.wasm candidate/u);
		assert.match(formatted, /must contain Swift compiler or SwiftPM identity metadata/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('warns when upstream Swift Wasm SDK artifacts lack checksum sidecars', () => {
	const actions = buildSwiftDoctorNextActions({
		upstream: {
			checked: true,
			hasBrowserCompilerBundle: false,
			sdkArtifactsMissingChecksums: [{ name: 'swift-6.3-RELEASE_wasm.artifactbundle.zip' }]
		},
		buildOutputs: { ready: false },
		readiness: { ready: false, registered: false }
	});

	assert.ok(actions.some((action) => /without matching \.sha256 sidecars/u.test(action)));
});

test('formats Swift readiness provenance snapshot usage in doctor output', () => {
	const formatted = formatSwiftDoctorReport({
		toolchain: { checked: false, swiftVersion: '6.3.3', wasmSdkId: 'swift-6.3.3-RELEASE_wasm' },
		disk: { probePath: '/workspace', minFreeGiB: 80, freeBytes: 100 * 1024 * 1024 * 1024, ok: true },
		upstream: { checked: false },
		buildOutputs: { buildDir: '/workspace/build', ready: true, validationErrors: {} },
		buildPlan: {
			planPath: '/workspace/build/build-plan.json',
			valid: true,
			hasBrowserCompilerContracts: true,
			errors: []
		},
		readiness: {
			bundleDir: '/repo/static/wasm-swift',
			assetVersion: 'abc123',
			ready: true,
			warnings: [],
			errors: [],
			provenance: {
				buildPlan: {
					planPath: '/workspace/build/build-plan.json',
					sourcePath: '/repo/static/wasm-swift/build-plan.snapshot.json',
					usedSnapshot: true
				},
				sourceBootstrapReceipt: {
					receiptPath: '/workspace/build/source-bootstrap.json',
					sourcePath: '/repo/static/wasm-swift/source-bootstrap.snapshot.json',
					usedSnapshot: true
				},
				browserBuildLog: {
					logPath: '/workspace/build/browser-build.log',
					sourcePath: '/repo/static/wasm-swift/browser-build.snapshot.log',
					usedSnapshot: true
				},
				baselineReceipts: [
					{
						preset: 'buildbot_linux_crosscompile_wasm',
						sourcePath: '/repo/static/wasm-swift/upstream-baseline-buildbot_linux_crosscompile_wasm.snapshot.json',
						usedSnapshot: true
					}
				]
			}
		},
		nextActions: ['Swift runtime readiness is green for the selected checks.']
	});

	assert.match(formatted, /build plan provenance: snapshot .*build-plan\.snapshot\.json/u);
	assert.match(formatted, /source bootstrap receipt: snapshot .*source-bootstrap\.snapshot\.json/u);
	assert.match(formatted, /browser build log: snapshot .*browser-build\.snapshot\.log/u);
	assert.match(formatted, /baseline buildbot_linux_crosscompile_wasm: snapshot .*upstream-baseline-buildbot_linux_crosscompile_wasm\.snapshot\.json/u);
});

test('separates upstream discovery failures from sdk-only next actions', () => {
	const actions = buildSwiftDoctorNextActions({
		upstream: {
			checked: true,
			ok: false,
			error: 'Swift upstream release discovery failed: HTTP 403',
			hasBrowserCompilerBundle: false,
			sdkArtifactsMissingChecksums: [],
			sdkArtifactsNotGzip: []
		},
		buildOutputs: { ready: false },
		readiness: { ready: false, registered: false }
	});

	assert.ok(actions.some((action) => /Fix Swift upstream discovery/u.test(action)));
	assert.ok(!actions.some((action) => /upstream currently exposes SDK artifacts/u.test(action)));
});

test('warns when upstream Swift Wasm SDK artifacts are not gzip archives', () => {
	const actions = buildSwiftDoctorNextActions({
		upstream: {
			checked: true,
			hasBrowserCompilerBundle: false,
			sdkArtifactsMissingChecksums: [],
			sdkArtifactsNotGzip: [{ name: 'swift-6.3-RELEASE_wasm.artifactbundle.zip' }]
		},
		buildOutputs: { ready: false },
		readiness: { ready: false, registered: false }
	});

	assert.ok(actions.some((action) => /zip artifactbundles directly to sdk\.tar\.gz/u.test(action)));
});

test('suggests probing the native Swift toolchain before browser compiler build work', () => {
	const actions = buildSwiftDoctorNextActions({
		upstream: { checked: false },
		toolchain: { checked: false },
		buildOutputs: { ready: false },
		readiness: { ready: false, registered: false }
	});

	assert.ok(actions.some((action) => /probe:toolchain/u.test(action)));
	assert.ok(actions.some((action) => /probe:install/u.test(action)));
});

test('does not suggest probing the native Swift toolchain after it is ready', () => {
	const actions = buildSwiftDoctorNextActions({
		upstream: { checked: true, ok: true, hasBrowserCompilerBundle: false },
		toolchain: {
			checked: true,
			ok: true,
			hostSwift: 'Swift version 6.3.3',
			selectedSdk: 'swift-6.3.3-RELEASE_wasm'
		},
		buildOutputs: { ready: false },
		readiness: { ready: false, registered: false }
	});

	assert.ok(!actions.some((action) => /probe:toolchain/u.test(action)));
	assert.ok(!actions.some((action) => /probe:install/u.test(action)));
	assert.ok(actions.some((action) => /build:wasm-swift-browser-compiler/u.test(action)));
});

test('suggests install commands when the native Swift toolchain probe failed', () => {
	const actions = buildSwiftDoctorNextActions({
		upstream: { checked: true, ok: true, hasBrowserCompilerBundle: false },
		toolchain: { checked: true, ok: false, error: 'Swift toolchain is not available' },
		buildOutputs: { ready: false },
		readiness: { ready: false, registered: false }
	});

	assert.ok(actions.some((action) => /Fix the native Swift\/Wasm SDK baseline/u.test(action)));
	assert.ok(actions.some((action) => /probe:install/u.test(action)));
	assert.ok(!actions.some((action) => /probe:toolchain to verify/u.test(action)));
});

test('suggests registration only after readiness is green but Swift is not registered', () => {
	const actions = buildSwiftDoctorNextActions({
		upstream: { checked: false },
		buildOutputs: { ready: true },
		readiness: { ready: true, registered: false }
	});
	assert.equal(actions.length, 1);
	assert.match(actions[0], /promote:wasm-swift/u);
	assert.match(actions[0], /apply:wasm-swift-registration/u);
	assert.match(actions[0], /browser contract remains green/u);
});
