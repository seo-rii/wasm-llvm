import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
	parseVerifyBuildOutputsArgs,
	validateSwiftBrowserBuildPlan,
	verifySwiftBrowserBuildOutputs
} from './verify-build-outputs.mjs';
import {
	OFFICIAL_WASM_SDK_CHECKSUM,
	OFFICIAL_WASM_SDK_URL
} from './probe-toolchain.mjs';
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

async function writePlan(planPath, plan) {
	await writeFixture(planPath, `${JSON.stringify(plan, null, 2)}\n`);
}

function createBrowserCompilerBuildContracts(expectedOutputs) {
	return {
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
				requiredIdentity: ['swiftpm', 'SwiftPM', 'Swift Package']
			},
			{
				name: 'sdk.tar.gz',
				expectedPath: expectedOutputs['sdk.tar.gz'],
				validation: 'validateSwiftSdkArchiveBytes'
			}
		]
	};
}

function createBrowserBuildExecution(overrides = {}) {
	return {
		status: 'passed',
		command: './build-swift-browser.sh',
		cwd: path.resolve('checkout'),
		buildDir: path.resolve('build'),
		rawRuntimeDir: path.resolve('raw-runtime'),
		planPath: path.resolve('build', 'wasm-idle-swift-browser-build-plan.json'),
		logPath: path.resolve('build', 'browser-build.log'),
		startedAt: '2026-01-01T00:00:00.000Z',
		finishedAt: '2026-01-01T00:00:01.000Z',
		exitCode: 0,
		...overrides
	};
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

test('parses Swift browser build output verifier arguments', () => {
	assert.deepEqual(parseVerifyBuildOutputsArgs(['--help']), { help: true });
	assert.deepEqual(parseVerifyBuildOutputsArgs([]), {
		planPath: path.resolve(
			import.meta.dirname,
			'..',
			'browser-compiler-build',
			'wasm-idle-swift-browser-build-plan.json'
		),
		allowOfficialSdkPlaceholder: false,
		prepareRawRuntime: false,
		requireBrowserCompilerContracts: false,
		requireBrowserBuildCommand: false,
		requireBrowserBuildExecution: false,
		requireBrowserBuildLog: false,
		requireSourceBootstrapProvenance: false,
		sdkUrl: OFFICIAL_WASM_SDK_URL,
		sdkChecksum: OFFICIAL_WASM_SDK_CHECKSUM
	});
	assert.deepEqual(
		parseVerifyBuildOutputsArgs([
			'--plan',
			'plan.json',
			'--allow-official-sdk-placeholder',
			'--prepare-raw-runtime',
			'--require-browser-compiler-contracts',
			'--require-browser-build-command',
			'--require-browser-build-execution',
			'--require-browser-build-log',
			'--require-source-bootstrap-provenance',
			'--sdk-url',
			'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
			'--sdk-checksum',
			'a'.repeat(64)
		]),
		{
			planPath: path.resolve('plan.json'),
			allowOfficialSdkPlaceholder: true,
			prepareRawRuntime: true,
			requireBrowserCompilerContracts: true,
			requireBrowserBuildCommand: true,
			requireBrowserBuildExecution: true,
			requireBrowserBuildLog: true,
			requireSourceBootstrapProvenance: true,
			sdkUrl: 'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
			sdkChecksum: 'a'.repeat(64)
		}
	);
	assert.throws(() => parseVerifyBuildOutputsArgs(['--plan']), /--plan requires a value/u);
	assert.throws(() => parseVerifyBuildOutputsArgs(['--unknown']), /Unknown option: --unknown/u);
});

test('validates Swift browser build plan structure', () => {
	assert.deepEqual(validateSwiftBrowserBuildPlan(null), ['build plan must be an object']);
	assert.deepEqual(
		validateSwiftBrowserBuildPlan({
			format: 'wrong',
			rawRuntimeDir: 'relative',
			expectedOutputs: {
				'runner-worker.js': 'relative',
				'swiftc.wasm': 'relative',
				'swiftpm.wasm': 'relative',
				'sdk.tar.gz': 'official-swift-wasm-sdk'
			}
		}),
		[
			'format must be wasm-idle-swift-browser-compiler-build-plan-v1',
			'rawRuntimeDir must be an absolute path',
			'expectedOutputs.runner-worker.js must be an absolute file path',
			'expectedOutputs.swiftc.wasm must be an absolute file path',
			'expectedOutputs.swiftpm.wasm must be an absolute file path'
		]
	);
	assert.deepEqual(
		validateSwiftBrowserBuildPlan(
			{
				format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
				rawRuntimeDir: path.resolve('raw-runtime'),
				expectedOutputs: {
					'runner-worker.js': path.resolve('runner-worker.js'),
					'swiftc.wasm': path.resolve('swiftc.wasm'),
					'swiftpm.wasm': path.resolve('swiftpm.wasm'),
					'sdk.tar.gz': 'official-swift-wasm-sdk'
				}
			},
			{ requireBrowserCompilerContracts: true }
		),
		['browserCompilerBuild.requiredOutputs must be an array']
	);
	const expectedOutputs = {
		'runner-worker.js': path.resolve('runner-worker.js'),
		'swiftc.wasm': path.resolve('swiftc.wasm'),
		'swiftpm.wasm': path.resolve('swiftpm.wasm'),
		'sdk.tar.gz': 'official-swift-wasm-sdk'
	};
	const sourceBootstrap = {
		path: path.resolve('bootstrap-receipt.json'),
		format: 'wasm-idle-swift-source-bootstrap-receipt-v1',
		status: 'passed',
		sourceRoot: path.resolve('checkout'),
		swiftRepository: 'https://github.com/swiftlang/swift.git',
		swiftRef: 'main',
		swiftCloneDepth: 1,
		swiftCloneFilter: 'blob:none',
		dependencyScheme: 'main',
		startedAt: '2026-01-01T00:00:00.000Z',
		finishedAt: '2026-01-01T00:00:01.000Z',
		checkout: { ok: true, missing: [] }
	};
	assert.deepEqual(
		validateSwiftBrowserBuildPlan(
			{
				format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
				checkoutRoot: path.resolve('checkout'),
				rawRuntimeDir: path.resolve('raw-runtime'),
				sourceBootstrap,
				expectedOutputs
			},
			{ requireSourceBootstrapProvenance: true }
		),
		[]
	);
	assert.deepEqual(
		validateSwiftBrowserBuildPlan(
			{
				format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
				rawRuntimeDir: path.resolve('raw-runtime'),
				expectedOutputs
			},
			{ requireSourceBootstrapProvenance: true }
		),
		['sourceBootstrap provenance is required']
	);
	assert.deepEqual(
		validateSwiftBrowserBuildPlan(
			{
				format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
				checkoutRoot: path.resolve('checkout'),
				rawRuntimeDir: path.resolve('raw-runtime'),
				sourceBootstrap: {
					...sourceBootstrap,
					status: 'failed',
					sourceRoot: path.resolve('other-checkout'),
					checkout: { ok: false, missing: [path.join('swiftpm', 'Package.swift')] }
				},
				expectedOutputs
			},
			{ requireSourceBootstrapProvenance: true }
		),
		[
			'sourceBootstrap.status must be passed',
			'sourceBootstrap.sourceRoot must match checkoutRoot',
			'sourceBootstrap.checkout.ok must be true'
		]
	);
	assert.deepEqual(
		validateSwiftBrowserBuildPlan(
			{
				format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
				rawRuntimeDir: path.resolve('raw-runtime'),
				expectedOutputs,
				browserCompilerBuild: createBrowserCompilerBuildContracts(expectedOutputs)
			},
			{ requireBrowserCompilerContracts: true }
		),
		[]
	);
	assert.deepEqual(
		validateSwiftBrowserBuildPlan(
			{
				format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
				rawRuntimeDir: path.resolve('raw-runtime'),
				expectedOutputs,
				browserCompilerBuild: createBrowserCompilerBuildContracts(expectedOutputs)
			},
			{ requireBrowserBuildCommand: true }
		),
		['browserCompilerBuild.command is required']
	);
	assert.deepEqual(
		validateSwiftBrowserBuildPlan(
			{
				format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
				checkoutRoot: path.resolve('checkout'),
				buildDir: path.resolve('build'),
				rawRuntimeDir: path.resolve('raw-runtime'),
				expectedOutputs,
				browserCompilerBuild: {
					...createBrowserCompilerBuildContracts(expectedOutputs),
					command: './build-swift-browser.sh',
					execution: createBrowserBuildExecution()
				}
			},
			{
				requireBrowserCompilerContracts: true,
				requireBrowserBuildCommand: true,
				requireBrowserBuildExecution: true
			}
		),
		[]
	);
	assert.deepEqual(
		validateSwiftBrowserBuildPlan(
			{
				format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
				rawRuntimeDir: path.resolve('raw-runtime'),
				expectedOutputs,
				browserCompilerBuild: {
					...createBrowserCompilerBuildContracts(expectedOutputs),
					command: './build-swift-browser.sh'
				}
			},
			{ requireBrowserBuildExecution: true }
		),
		['browserCompilerBuild.execution provenance is required']
	);
	assert.deepEqual(
		validateSwiftBrowserBuildPlan(
			{
				format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
				checkoutRoot: path.resolve('checkout'),
				buildDir: path.resolve('build'),
				rawRuntimeDir: path.resolve('raw-runtime'),
				expectedOutputs,
				browserCompilerBuild: {
					...createBrowserCompilerBuildContracts(expectedOutputs),
					command: './build-swift-browser.sh',
					execution: createBrowserBuildExecution({
						status: 'failed',
						command: './other-build.sh',
						cwd: path.resolve('other-checkout'),
						buildDir: path.resolve('other-build'),
						rawRuntimeDir: path.resolve('other-raw'),
						logPath: 'relative-build.log',
						startedAt: '2026-01-01T00:00:02.000Z',
						finishedAt: '2026-01-01T00:00:01.000Z',
						exitCode: 1
					})
				}
			},
			{ requireBrowserBuildExecution: true }
		),
		[
			'browserCompilerBuild.execution.status must be passed',
			'browserCompilerBuild.execution.command must match browserCompilerBuild.command',
			'browserCompilerBuild.execution.cwd must match checkoutRoot',
			'browserCompilerBuild.execution.buildDir must match buildDir',
			'browserCompilerBuild.execution.rawRuntimeDir must match rawRuntimeDir',
			'browserCompilerBuild.execution.finishedAt must not be before startedAt',
			'browserCompilerBuild.execution.exitCode must be 0',
			'browserCompilerBuild.execution.logPath must be an absolute path when provided'
		]
	);
	assert.deepEqual(
		validateSwiftBrowserBuildPlan(
			{
				format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
				rawRuntimeDir: path.resolve('raw-runtime'),
				expectedOutputs,
				browserCompilerBuild: {
					...createBrowserCompilerBuildContracts(expectedOutputs),
					command: './build-swift-browser.sh',
					execution: createBrowserBuildExecution({ logPath: null })
				}
			},
			{ requireBrowserBuildLog: true }
		),
		['browserCompilerBuild.execution.logPath is required']
	);
	assert.deepEqual(
		validateSwiftBrowserBuildPlan(
			{
				format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
				rawRuntimeDir: path.resolve('raw-runtime'),
				expectedOutputs,
				browserCompilerBuild: {
					runtimeContract: createSwiftRuntimeContract(),
					requiredOutputs: createBrowserCompilerBuildContracts(expectedOutputs).requiredOutputs.map(
						(output) =>
							output.name === 'swiftc.wasm'
								? { ...output, requiredIdentity: ['compiler'] }
								: output
					)
				}
			},
			{ requireBrowserCompilerContracts: true }
		),
		[
			'browserCompilerBuild.requiredOutputs.swiftc.wasm.requiredIdentity must include swift',
			'browserCompilerBuild.requiredOutputs.swiftc.wasm.requiredIdentity must include swiftc'
		]
	);
	assert.deepEqual(
		validateSwiftBrowserBuildPlan(
			{
				format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
				rawRuntimeDir: path.resolve('raw-runtime'),
				expectedOutputs,
				browserCompilerBuild: {
					...createBrowserCompilerBuildContracts(expectedOutputs),
					runtimeContract: {
						...createSwiftRuntimeContract(),
						version: 0
					}
				}
			},
			{ requireBrowserCompilerContracts: true }
		),
		['browserCompilerBuild.runtimeContract version must be 2']
	);
	assert.deepEqual(
		validateSwiftBrowserBuildPlan(
			{
				format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
				rawRuntimeDir: path.resolve('raw-runtime'),
				expectedOutputs,
				browserCompilerBuild: {
					...createBrowserCompilerBuildContracts(expectedOutputs),
					runtimeContract: {
						...createSwiftRuntimeContract(),
						cases: createSwiftRuntimeContract().cases.filter(
							(testCase) => testCase.name !== 'stdin-multiline'
						)
					}
				}
			},
			{ requireBrowserCompilerContracts: true }
		),
		[
			'browserCompilerBuild.runtimeContract.cases must exactly match stdin-readline, stdin-multiline, program-arguments, workspace-files, compile-error'
		]
	);
	assert.deepEqual(
		validateSwiftBrowserBuildPlan(
			{
				format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
				rawRuntimeDir: path.resolve('raw-runtime'),
				expectedOutputs,
				browserCompilerBuild: {
					...createBrowserCompilerBuildContracts(expectedOutputs),
					runtimeContract: {
						...createSwiftRuntimeContract(),
						cases: createSwiftRuntimeContract().cases.map((testCase) =>
							testCase.name === 'stdin-multiline'
								? { ...testCase, expectedStdout: 'wrong\n' }
								: testCase
						)
					}
				}
			},
			{ requireBrowserCompilerContracts: true }
		),
		['browserCompilerBuild.runtimeContract must match the current Swift browser runtime contract']
	);
});

test('verifies concrete Swift browser build outputs from a build plan', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-verify-build-'));
	try {
		const planPath = path.join(dir, 'plan.json');
		const rawRuntimeDir = path.join(dir, 'raw-runtime');
		const outputsDir = path.join(dir, 'outputs');
		const plan = {
			format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
			rawRuntimeDir,
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
				'sdk.tar.gz': await writeFixture(path.join(outputsDir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES)
			}
		};
		await writePlan(planPath, plan);

		const result = await verifySwiftBrowserBuildOutputs({ planPath, prepareRawRuntime: true });

		assert.deepEqual(result, {
			planPath,
			rawRuntimeDir,
			outputs: plan.expectedOutputs,
			officialSdkPlaceholder: false
		});
		await stat(path.join(rawRuntimeDir, 'runner-worker.js'));
		await stat(path.join(rawRuntimeDir, 'swiftc.wasm'));
		await stat(path.join(rawRuntimeDir, 'swiftpm.wasm'));
		await stat(path.join(rawRuntimeDir, 'sdk.tar.gz'));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('requires the Swift browser build execution log file when requested', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-verify-build-log-'));
	try {
		const planPath = path.join(dir, 'plan.json');
		const outputsDir = path.join(dir, 'outputs');
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
		const buildLog = path.join(dir, 'logs', 'browser-build.log');
		const plan = {
			format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
			checkoutRoot: path.resolve('checkout'),
			buildDir: path.resolve('build'),
			rawRuntimeDir: path.join(dir, 'raw-runtime'),
			expectedOutputs,
			browserCompilerBuild: {
				...createBrowserCompilerBuildContracts(expectedOutputs),
				command: './build-swift-browser.sh',
				execution: createBrowserBuildExecution({
					rawRuntimeDir: path.join(dir, 'raw-runtime'),
					logPath: buildLog
				})
			}
		};
		await writePlan(planPath, plan);

		await assert.rejects(
			() =>
				verifySwiftBrowserBuildOutputs({
					planPath,
					requireBrowserBuildLog: true
				}),
			new RegExp(
				`browserCompilerBuild\\.execution\\.logPath file was not found: ${buildLog.replace(
					/[.*+?^${}()|[\]\\]/gu,
					'\\$&'
				)}`,
				'u'
			)
		);

		await writeFixture(buildLog, 'browser build log\n');
		await assert.doesNotReject(() =>
			verifySwiftBrowserBuildOutputs({
				planPath,
				requireBrowserBuildLog: true
			})
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('allows the official SDK placeholder only when requested', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-verify-official-sdk-'));
	try {
		const planPath = path.join(dir, 'plan.json');
		const outputsDir = path.join(dir, 'outputs');
		await writePlan(planPath, {
			format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
			rawRuntimeDir: path.join(dir, 'raw-runtime'),
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
			}
		});

		await assert.rejects(
			() => verifySwiftBrowserBuildOutputs({ planPath }),
			/official Swift SDK placeholder/u
		);
		const result = await verifySwiftBrowserBuildOutputs({
			planPath,
			allowOfficialSdkPlaceholder: true
		});
		assert.equal(result.officialSdkPlaceholder, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects missing or invalid Swift browser build outputs', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-verify-invalid-'));
	try {
		const planPath = path.join(dir, 'plan.json');
		const outputsDir = path.join(dir, 'outputs');
		await writePlan(planPath, {
			format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
			rawRuntimeDir: path.join(dir, 'raw-runtime'),
			expectedOutputs: {
				'runner-worker.js': await writeFixture(path.join(outputsDir, 'runner-worker.js'), 'self.onmessage = () => {};'),
				'swiftc.wasm': await writeFixture(path.join(outputsDir, 'swiftc.wasm'), 'not wasm'),
				'swiftpm.wasm': path.join(outputsDir, 'missing-swiftpm.wasm'),
				'sdk.tar.gz': await writeFixture(path.join(outputsDir, 'sdk.tar.gz'), 'not gzip')
			}
		});

		await assert.rejects(
			() => verifySwiftBrowserBuildOutputs({ planPath }),
			(error) => {
				assert.match(error.message, /runner-worker\.js must read run/u);
				assert.match(error.message, /swiftc\.wasm must start/u);
				assert.match(error.message, /swiftpm\.wasm was not found/u);
				assert.match(error.message, /sdk\.tar\.gz must be a gzip/u);
				return true;
			}
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects Swift browser build wasm outputs that fail module compilation', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-verify-invalid-module-'));
	try {
		const planPath = path.join(dir, 'plan.json');
		const outputsDir = path.join(dir, 'outputs');
		await writePlan(planPath, {
			format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
			rawRuntimeDir: path.join(dir, 'raw-runtime'),
			expectedOutputs: {
				'runner-worker.js': await writeFixture(
					path.join(outputsDir, 'runner-worker.js'),
					VALID_RUNNER_WORKER_SOURCE
				),
				'swiftc.wasm': await writeFixture(
					path.join(outputsDir, 'swiftc.wasm'),
					Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1)
				),
				'swiftpm.wasm': await writeFixture(
					path.join(outputsDir, 'swiftpm.wasm'),
					taggedWasm('swiftpm SwiftPM')
				),
				'sdk.tar.gz': await writeFixture(path.join(outputsDir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES)
			}
		});

		await assert.rejects(
			() => verifySwiftBrowserBuildOutputs({ planPath }),
			/swiftc\.wasm must be a valid WebAssembly module/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects Swift browser build wasm outputs without Swift identity metadata', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-verify-no-identity-'));
	try {
		const planPath = path.join(dir, 'plan.json');
		const outputsDir = path.join(dir, 'outputs');
		await writePlan(planPath, {
			format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
			rawRuntimeDir: path.join(dir, 'raw-runtime'),
			expectedOutputs: {
				'runner-worker.js': await writeFixture(
					path.join(outputsDir, 'runner-worker.js'),
					VALID_RUNNER_WORKER_SOURCE
				),
				'swiftc.wasm': await writeFixture(
					path.join(outputsDir, 'swiftc.wasm'),
					Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)
				),
				'swiftpm.wasm': await writeFixture(
					path.join(outputsDir, 'swiftpm.wasm'),
					taggedWasm('swiftpm SwiftPM')
				),
				'sdk.tar.gz': await writeFixture(path.join(outputsDir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES)
			}
		});

		await assert.rejects(
			() => verifySwiftBrowserBuildOutputs({ planPath }),
			/swiftc\.wasm must contain Swift compiler or SwiftPM identity metadata/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('can fetch the official SDK while preparing verified raw runtime outputs', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-verify-fetch-sdk-'));
	try {
		const planPath = path.join(dir, 'plan.json');
		const rawRuntimeDir = path.join(dir, 'raw-runtime');
		const outputsDir = path.join(dir, 'outputs');
		const sdkBytes = VALID_SDK_ARCHIVE_BYTES;
		await writePlan(planPath, {
			format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
			rawRuntimeDir,
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
			}
		});

		await verifySwiftBrowserBuildOutputs({
			planPath,
			allowOfficialSdkPlaceholder: true,
			prepareRawRuntime: true,
			sdkUrl: 'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
			sdkChecksum: sha256(sdkBytes),
			fetchImpl: async () => ({
				ok: true,
				status: 200,
				arrayBuffer: async () =>
					sdkBytes.buffer.slice(sdkBytes.byteOffset, sdkBytes.byteOffset + sdkBytes.byteLength)
			})
		});

		assert.deepEqual(new Uint8Array(await readFile(path.join(rawRuntimeDir, 'sdk.tar.gz'))), sdkBytes);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
