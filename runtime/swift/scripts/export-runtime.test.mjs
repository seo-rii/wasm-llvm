import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
	exportSwiftRuntimeArchive,
	parseExportSwiftRuntimeArgs
} from './export-runtime.mjs';
import { resolveSwiftRuntimeImportSource } from './import-runtime.mjs';
import { packageSwiftRuntimeFromBuildPlan } from './package-from-build-plan.mjs';
import { packageSwiftRuntimeDist } from './package-runtime.mjs';
import { createSwiftRuntimeContract } from './runtime-contract.mjs';
import { EXPECTED_MANIFEST_RUNTIME_CONTRACT } from './runtime-manifest.mjs';

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
}

async function writeValidSourceBundle(sourceDir) {
	await writeFixture(path.join(sourceDir, 'runner-worker.js'), VALID_RUNNER_WORKER_SOURCE);
	await writeFixture(path.join(sourceDir, 'swiftc.wasm'), taggedWasm('swiftc Swift compiler'));
	await writeFixture(path.join(sourceDir, 'swiftpm.wasm'), taggedWasm('swiftpm SwiftPM'));
	await writeFixture(path.join(sourceDir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES);
	await writeFixture(path.join(sourceDir, 'SOURCE.txt'), 'external CI bundle\n');
}

async function sha256File(filePath) {
	return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

test('parses Swift runtime export CLI arguments', () => {
	assert.deepEqual(parseExportSwiftRuntimeArgs(['--help']), { help: true });
	const parsed = parseExportSwiftRuntimeArgs([
		'--bundle-dir',
		'dist',
		'--out-dir',
		'out',
		'--archive-name',
		'wasm-swift-test.tar.gz',
		'--url',
		'https://example.test/wasm-swift-test.tar.gz',
		'--browser-contract',
		'--require-build-plan-provenance',
		'--require-source-bootstrap-provenance',
		'--require-browser-build-command-provenance',
		'--require-browser-build-execution-provenance',
		'--require-browser-build-log-provenance',
		'--require-upstream-baseline-provenance',
		'--timeout-ms',
		'1000'
	]);

	assert.equal(parsed.bundleDir, path.resolve('dist'));
	assert.equal(parsed.outDir, path.resolve('out'));
	assert.equal(parsed.archiveName, 'wasm-swift-test.tar.gz');
	assert.equal(parsed.url, 'https://example.test/wasm-swift-test.tar.gz');
	assert.equal(parsed.runBrowserContract, true);
	assert.equal(parsed.requireBuildPlanProvenance, true);
	assert.equal(parsed.requireSourceBootstrapProvenance, true);
	assert.equal(parsed.requireBrowserBuildCommandProvenance, true);
	assert.equal(parsed.requireBrowserBuildExecutionProvenance, true);
	assert.equal(parsed.requireBrowserBuildLogProvenance, true);
	assert.equal(parsed.requireBaselineProvenance, true);
	assert.equal(parsed.timeoutMs, 1000);
	assert.throws(
		() => parseExportSwiftRuntimeArgs(['--archive-name', '../bad.tar.gz']),
		/archiveName must/u
	);
	assert.throws(() => parseExportSwiftRuntimeArgs(['--timeout-ms', '0']), /timeoutMs must/u);
	assert.throws(() => parseExportSwiftRuntimeArgs(['--url', 'file:///tmp/a.tar.gz']), /url must/u);
});

test('exports a validated Swift runtime bundle as archive, checksum, and descriptor', async () => {
	const workDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-export-'));
	const sourceDir = path.join(workDir, 'source');
	const distDir = path.join(workDir, 'dist');
	const outDir = path.join(workDir, 'out');
	try {
		await writeValidSourceBundle(sourceDir);
		const packaged = await packageSwiftRuntimeDist({
			sourceDir,
			distDir,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			source: 'export unit test'
		});

		const exported = await exportSwiftRuntimeArchive({
			bundleDir: distDir,
			outDir,
			url: 'https://example.test/wasm-swift.tar.gz'
		});

		assert.equal(exported.archiveSha256, await sha256File(exported.archivePath));
		assert.match(await readFile(exported.sha256Path, 'utf8'), new RegExp(exported.archiveSha256, 'u'));
		const descriptor = JSON.parse(await readFile(exported.descriptorPath, 'utf8'));
		assert.equal(descriptor.format, 'wasm-swift-runtime-export-v1');
		assert.equal(descriptor.archiveSha256, exported.archiveSha256);
		assert.equal(descriptor.fingerprint, packaged.fingerprint);
		assert.equal(descriptor.swiftVersion, '6.3.3');
		assert.equal(descriptor.url, 'https://example.test/wasm-swift.tar.gz');
		assert.equal(
			descriptor.runtimeBuildSha256,
			await sha256File(path.join(distDir, 'runtime-build.json'))
		);
		assert.ok(descriptor.files.some((file) => file.path === 'swiftc.wasm'));

		const imported = await resolveSwiftRuntimeImportSource(exported.archivePath);
		try {
			assert.match(imported.sourceDir, /wasm-swift-import-/u);
		} finally {
			await imported.cleanup();
		}
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
});

test('rejects strict Swift runtime export without build provenance', async () => {
	const workDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-export-strict-missing-'));
	const sourceDir = path.join(workDir, 'source');
	const distDir = path.join(workDir, 'dist');
	try {
		await writeValidSourceBundle(sourceDir);
		await packageSwiftRuntimeDist({
			sourceDir,
			distDir,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			source: 'export unit test'
		});

		await assert.rejects(
			() =>
				exportSwiftRuntimeArchive({
					bundleDir: distDir,
					outDir: path.join(workDir, 'out'),
					requireBuildPlanProvenance: true,
					requireBrowserBuildCommandProvenance: true,
					requireBaselineProvenance: true
				}),
			/build plan provenance is required/u
		);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
});

test('rejects Swift runtime export when SDK checksum metadata does not match archive bytes', async () => {
	const workDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-export-sdk-checksum-'));
	const sourceDir = path.join(workDir, 'source');
	const distDir = path.join(workDir, 'dist');
	try {
		await writeValidSourceBundle(sourceDir);
		await packageSwiftRuntimeDist({
			sourceDir,
			distDir,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			source: 'export unit test'
		});
		const buildInfoPath = path.join(distDir, 'runtime-build.json');
		const buildInfo = JSON.parse(await readFile(buildInfoPath, 'utf8'));
		await writeFile(
			buildInfoPath,
			`${JSON.stringify(
				{
					...buildInfo,
					wasmSdkUrl:
						'https://download.swift.org/swift-6.3.3-release/wasm-sdk/swift-6.3.3-RELEASE/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
					wasmSdkChecksum: 'd'.repeat(64)
				},
				null,
				2
			)}\n`
		);

		await assert.rejects(
			() =>
				exportSwiftRuntimeArchive({
					bundleDir: distDir,
					outDir: path.join(workDir, 'out')
				}),
			/runtime-build\.json wasmSdkChecksum [a-f0-9]{64} does not match sdk\.tar\.gz sha256/u
		);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
});

test('exports a strict Swift runtime bundle with build plan and baseline provenance', async () => {
	const workDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-export-strict-'));
	const outputsDir = path.join(workDir, 'outputs');
	const rawRuntimeDir = path.join(workDir, 'raw-runtime');
	const distDir = path.join(workDir, 'dist');
	const outDir = path.join(workDir, 'out');
	const planPath = path.join(workDir, 'build-plan.json');
	const receiptPath = path.join(workDir, 'baseline-receipt.json');
	const bootstrapReceiptPath = path.join(workDir, 'source-bootstrap-receipt.json');
	try {
		const baselineCommand = ['utils/build-script', '--preset', 'buildbot_linux_crosscompile_wasm'];
		const bootstrapReceipt = {
			format: 'wasm-idle-swift-source-bootstrap-receipt-v1',
			status: 'passed',
			sourceRoot: path.join(workDir, 'checkout'),
			swiftRepository: 'https://github.com/swiftlang/swift.git',
			swiftRef: 'swift-6.3.3-RELEASE',
			swiftCloneDepth: 1,
			swiftCloneFilter: 'blob:none',
			dependencyScheme: 'main',
			startedAt: '2026-01-01T00:00:00.000Z',
			finishedAt: '2026-01-01T00:00:01.000Z',
			checkout: { ok: true, missing: [] }
		};
		const bootstrapReceiptBytes = Buffer.from(
			`${JSON.stringify(bootstrapReceipt, null, 2)}\n`
		);
		await writeFixture(bootstrapReceiptPath, bootstrapReceiptBytes);
		const receiptBytes = Buffer.from(
			`${JSON.stringify(
				{
					format: 'wasm-idle-swift-upstream-baseline-build-v1',
					preset: 'buildbot_linux_crosscompile_wasm',
					planPath,
					command: baselineCommand,
					cwd: workDir,
					status: 'passed',
					exitCode: 0,
					startedAt: '2026-01-01T00:00:00.000Z',
					finishedAt: '2026-01-01T00:00:01.000Z'
				},
				null,
				2
			)}\n`
		);
		await writeFixture(receiptPath, receiptBytes);
		const expectedOutputs = {
			'runner-worker.js': path.join(outputsDir, 'runner-worker.js'),
			'swiftc.wasm': path.join(outputsDir, 'swiftc.wasm'),
			'swiftpm.wasm': path.join(outputsDir, 'swiftpm.wasm'),
			'sdk.tar.gz': path.join(outputsDir, 'sdk.tar.gz')
		};
		await writeFixture(expectedOutputs['runner-worker.js'], VALID_RUNNER_WORKER_SOURCE);
		await writeFixture(expectedOutputs['swiftc.wasm'], taggedWasm('swiftc Swift compiler'));
		await writeFixture(expectedOutputs['swiftpm.wasm'], taggedWasm('swiftpm SwiftPM'));
		await writeFixture(expectedOutputs['sdk.tar.gz'], VALID_SDK_ARCHIVE_BYTES);
		await writeFixture(
			planPath,
			`${JSON.stringify(
				{
					format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
					checkoutRoot: bootstrapReceipt.sourceRoot,
					rawRuntimeDir,
					sourceBootstrap: {
						path: bootstrapReceiptPath,
						...bootstrapReceipt
					},
					expectedOutputs,
					upstreamWasmBaseline: {
						presets: ['buildbot_linux_crosscompile_wasm'],
						commands: [baselineCommand],
						receipts: [
							{
								preset: 'buildbot_linux_crosscompile_wasm',
								path: receiptPath,
								sha256: createHash('sha256').update(receiptBytes).digest('hex'),
								status: 'passed'
							}
						]
					},
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
		await packageSwiftRuntimeFromBuildPlan({
			planPath,
			distDir,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			source: 'strict export unit test',
			requireUpstreamBaselineReceipt: true,
			requireBrowserCompilerContracts: true,
			requireBrowserBuildCommand: true,
			requireSourceBootstrapProvenance: true
		});

		const exported = await exportSwiftRuntimeArchive({
			bundleDir: distDir,
			outDir,
			requireBuildPlanProvenance: true,
			requireSourceBootstrapProvenance: true,
			requireBrowserBuildCommandProvenance: true,
			requireBaselineProvenance: true
		});

		assert.equal(exported.archiveSha256, await sha256File(exported.archivePath));
		assert.match(exported.descriptor.buildSource, /strict export unit test/u);
		assert.match(exported.descriptor.fingerprint, /^[a-f0-9]{16}$/u);
		assert.equal(
			exported.descriptor.runtimeBuildSha256,
			await sha256File(path.join(distDir, 'runtime-build.json'))
		);
		assert.deepEqual(exported.descriptor.runtimeContract, EXPECTED_MANIFEST_RUNTIME_CONTRACT);
		assert.ok(exported.descriptor.files.some((file) => file.path === 'swiftc.wasm'));
		assert.ok(exported.descriptor.files.some((file) => file.path === 'swiftpm.wasm'));
		assert.ok(exported.descriptor.files.some((file) => file.path === 'sdk.tar.gz'));
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
});

test('rejects Swift runtime export when bundle metadata is invalid', async () => {
	const workDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-export-invalid-'));
	try {
		await mkdir(workDir, { recursive: true });
		await writeFile(path.join(workDir, 'runtime-manifest.v1.json'), '{}\n');
		await writeFile(path.join(workDir, 'runtime-build.json'), '{}\n');
		await assert.rejects(
			() => exportSwiftRuntimeArchive({ bundleDir: workDir, outDir: path.join(workDir, 'out') }),
			/not exportable/u
		);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
});
