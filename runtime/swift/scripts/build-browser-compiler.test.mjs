import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
	classifySwiftBrowserBuildCommand,
	createSwiftBrowserCompilerBuildPlan,
	inspectBuildTools,
	inspectSwiftSourceCheckout,
	parseBuildBrowserCompilerArgs,
	runSwiftBrowserCompilerBuildHarness
} from './build-browser-compiler.mjs';
import { createSwiftRuntimeContract } from './runtime-contract.mjs';

async function writeFixture(filePath, contents = '') {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, contents);
}

async function writeSwiftCheckoutFixture(root) {
	await writeFixture(path.join(root, 'swift', 'utils', 'build-script'), '#!/usr/bin/env python3\n');
	await writeFixture(path.join(root, 'swift', 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n');
	await writeFixture(path.join(root, 'llvm-project', 'llvm', 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n');
	await writeFixture(path.join(root, 'swiftpm', 'Package.swift'), '// swift-tools-version: 6.3\n');
}

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

test('parses Swift browser compiler build harness arguments', () => {
	assert.deepEqual(parseBuildBrowserCompilerArgs(['--help']), { help: true });
	assert.deepEqual(parseBuildBrowserCompilerArgs([]), {
		checkoutRoot: null,
		buildDir: path.resolve(import.meta.dirname, '..', 'browser-compiler-build'),
		rawRuntimeDir: path.resolve(import.meta.dirname, '..', 'raw-runtime'),
		planPath: null,
		sourceBootstrapReceipt: null,
		requiredTools: ['python3', 'cmake', 'ninja'],
		allowMissingTools: false,
		prepareRawRuntime: false,
		fetchOfficialSdk: false,
		browserBuildCommand: null,
		browserBuildLog: null,
		executeBrowserBuildCommand: false,
		discoverBuildOutputs: false,
		inputs: {}
	});
	assert.deepEqual(
		parseBuildBrowserCompilerArgs([
			'--checkout-root',
			'checkout',
			'--build-dir',
			'build',
			'--raw-runtime-dir',
			'raw',
			'--plan-path',
			'plan.json',
			'--source-bootstrap-receipt',
			'bootstrap-receipt.json',
			'--require-tool',
			'wasm-ld',
			'--allow-missing-tools',
			'--prepare-raw-runtime',
			'--fetch-official-sdk',
			'--browser-build-command',
			'./build-swift-browser.sh',
			'--browser-build-log',
			'browser-build.log',
			'--execute-browser-build-command',
			'--discover-build-outputs',
			'--runner-worker',
			'runner-worker.js',
			'--swiftc-wasm',
			'swiftc.wasm',
			'--swiftpm-wasm',
			'swiftpm.wasm',
			'--sdk-archive',
			'sdk.tar.gz'
		]),
		{
			checkoutRoot: path.resolve('checkout'),
			buildDir: path.resolve('build'),
			rawRuntimeDir: path.resolve('raw'),
			planPath: path.resolve('plan.json'),
			sourceBootstrapReceipt: path.resolve('bootstrap-receipt.json'),
			requiredTools: ['python3', 'cmake', 'ninja', 'wasm-ld'],
			allowMissingTools: true,
			prepareRawRuntime: true,
			fetchOfficialSdk: true,
			browserBuildCommand: './build-swift-browser.sh',
			browserBuildLog: path.resolve('browser-build.log'),
			executeBrowserBuildCommand: true,
			discoverBuildOutputs: true,
			inputs: {
				'runner-worker.js': path.resolve('runner-worker.js'),
				'swiftc.wasm': path.resolve('swiftc.wasm'),
				'swiftpm.wasm': path.resolve('swiftpm.wasm'),
				'sdk.tar.gz': path.resolve('sdk.tar.gz')
			}
		}
	);
	assert.throws(() => parseBuildBrowserCompilerArgs(['--checkout-root']), /--checkout-root requires a value/u);
	assert.throws(() => parseBuildBrowserCompilerArgs(['--unknown']), /Unknown option: --unknown/u);
});

test('classifies baseline-only Swift presets as invalid browser build commands', () => {
	assert.deepEqual(classifySwiftBrowserBuildCommand('./build-swift-browser.sh'), { ok: true });
	assert.deepEqual(classifySwiftBrowserBuildCommand('true'), {
		ok: false,
		error:
			'browser build command must run the build or promotion step that creates runner-worker.js, swiftc.wasm, and swiftpm.wasm; no-op/documentation commands are not accepted.'
	});
	assert.deepEqual(classifySwiftBrowserBuildCommand('echo already built'), {
		ok: false,
		error:
			'browser build command must run the build or promotion step that creates runner-worker.js, swiftc.wasm, and swiftpm.wasm; no-op/documentation commands are not accepted.'
	});
	assert.deepEqual(
		classifySwiftBrowserBuildCommand(
			'swift/utils/build-script --preset buildbot_linux_crosscompile_wasm'
		),
		{
			ok: false,
			preset: 'buildbot_linux_crosscompile_wasm',
			error:
				'buildbot_linux_crosscompile_wasm is a native Swift/WASI baseline preset, not a browser compiler build command. Use it through run:wasm-swift-upstream-baseline and provide the command that actually creates runner-worker.js, swiftc.wasm, and swiftpm.wasm.'
		}
	);
	assert.deepEqual(
		classifySwiftBrowserBuildCommand(
			'swift/utils/build-script --preset buildbot_linux_crosscompile_wasm && ./copy-browser-runtime.sh'
		),
		{ ok: true }
	);
});

test('validates the expected Swift monorepo checkout layout', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-checkout-'));
	try {
		assert.deepEqual(await inspectSwiftSourceCheckout(dir), {
			checkoutRoot: dir,
			ok: false,
			missing: [
				path.join('swift', 'utils', 'build-script'),
				path.join('swift', 'CMakeLists.txt'),
				path.join('llvm-project', 'llvm', 'CMakeLists.txt'),
				path.join('swiftpm', 'Package.swift')
			]
		});
		await writeSwiftCheckoutFixture(dir);
		assert.deepEqual(await inspectSwiftSourceCheckout(dir), {
			checkoutRoot: dir,
			ok: true,
			missing: []
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('probes required Swift browser compiler build tools', async () => {
	const result = await inspectBuildTools(['python3', 'missing-tool'], async (tool) => ({
		tool,
		ok: tool !== 'missing-tool',
		version: tool === 'missing-tool' ? null : `${tool} version`
	}));

	assert.deepEqual(result, [
		{ tool: 'python3', ok: true, version: 'python3 version' },
		{ tool: 'missing-tool', ok: false, version: null }
	]);
	await assert.rejects(
		() => inspectBuildTools([''], async () => ({ ok: true })),
		/non-empty command names/u
	);
});

test('writes a Swift browser compiler build plan for a validated checkout', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-build-plan-'));
	try {
		const checkoutRoot = path.join(dir, 'checkout');
		const buildDir = path.join(dir, 'build');
		const rawRuntimeDir = path.join(dir, 'raw-runtime');
		const planPath = path.join(dir, 'plan.json');
		const bootstrapReceiptPath = path.join(dir, 'bootstrap-receipt.json');
		await writeSwiftCheckoutFixture(checkoutRoot);
		await writeFixture(
			bootstrapReceiptPath,
			`${JSON.stringify({
				format: 'wasm-idle-swift-source-bootstrap-receipt-v1',
				status: 'passed',
				sourceRoot: checkoutRoot,
				swiftRepository: 'https://github.com/swiftlang/swift.git',
				swiftRef: 'main',
				swiftCloneDepth: 1,
				swiftCloneFilter: 'blob:none',
				dependencyScheme: 'main',
				startedAt: '2026-01-01T00:00:00.000Z',
				finishedAt: '2026-01-01T00:00:01.000Z',
				checkout: { ok: true, missing: [] }
			})}\n`
		);

		const result = await createSwiftBrowserCompilerBuildPlan({
			checkoutRoot,
			buildDir,
			rawRuntimeDir,
			planPath,
			sourceBootstrapReceipt: bootstrapReceiptPath,
			requiredTools: ['python3', 'cmake', 'ninja', 'wasm-ld'],
			allowMissingTools: true,
			fetchOfficialSdk: true,
			browserBuildCommand: './build-swift-browser.sh',
			inputs: {
				'runner-worker.js': path.join(buildDir, 'runner-worker.js')
			},
			runTool: async (tool) => ({
				tool,
				ok: tool !== 'wasm-ld',
				version: tool === 'wasm-ld' ? null : `${tool} version`,
				...(tool === 'wasm-ld' ? { error: 'not found' } : {})
			})
		});

		assert.equal(result.planPath, planPath);
		assert.deepEqual(result.plan.sourceBootstrap, {
			path: bootstrapReceiptPath,
			format: 'wasm-idle-swift-source-bootstrap-receipt-v1',
			status: 'passed',
			sourceRoot: checkoutRoot,
			swiftRepository: 'https://github.com/swiftlang/swift.git',
			swiftRef: 'main',
			swiftCloneDepth: 1,
			swiftCloneFilter: 'blob:none',
			dependencyScheme: 'main',
			startedAt: '2026-01-01T00:00:00.000Z',
			finishedAt: '2026-01-01T00:00:01.000Z',
			checkout: { ok: true, missing: [] }
		});
		assert.deepEqual(result.plan.expectedOutputs, {
			'runner-worker.js': path.join(buildDir, 'runner-worker.js'),
			'swiftc.wasm': path.join(buildDir, 'swiftc.wasm'),
			'swiftpm.wasm': path.join(buildDir, 'swiftpm.wasm'),
			'sdk.tar.gz': 'official-swift-wasm-sdk'
		});
		assert.deepEqual(result.plan.upstreamWasmBaseline.presets, [
			'buildbot_linux_crosscompile_wasm',
			'wasm_stdlib',
			'wasm_stdlib_incremental'
		]);
		assert.deepEqual(result.plan.upstreamWasmBaseline.commands[0], [
			path.join(checkoutRoot, 'swift', 'utils', 'build-script'),
			'--preset',
			'buildbot_linux_crosscompile_wasm'
		]);
		assert.match(result.plan.upstreamWasmBaseline.note, /not treated as proof/u);
		assert.equal(result.plan.browserCompilerBuild.command, './build-swift-browser.sh');
		assert.deepEqual(
			result.plan.browserCompilerBuild.requiredOutputs.map((output) => ({
				name: output.name,
				expectedPath: output.expectedPath,
				validation: output.validation,
				requiredIdentity: output.requiredIdentity
			})),
			[
				{
					name: 'runner-worker.js',
					expectedPath: path.join(buildDir, 'runner-worker.js'),
					validation: 'validateSwiftRunnerWorkerSource',
					requiredIdentity: undefined
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
					requiredIdentity: ['swiftpm', 'SwiftPM', 'Swift Package']
				},
				{
					name: 'sdk.tar.gz',
					expectedPath: 'official-swift-wasm-sdk',
					validation: 'validateSwiftSdkArchiveBytes',
					requiredIdentity: undefined
				}
			]
		);
		assert.match(result.plan.browserCompilerBuild.note, /Native SwiftWasm SDK artifactbundles/u);
		assert.deepEqual(result.plan.browserCompilerBuild.runtimeContract, createSwiftRuntimeContract());
		assert.ok(
			result.plan.nextCommands.includes(
				`${path.join(checkoutRoot, 'swift', 'utils', 'build-script')} --preset buildbot_linux_crosscompile_wasm`
			)
		);
		assert.ok(
			result.plan.nextCommands.some((command) =>
				command.includes('run:wasm-swift-upstream-baseline')
			)
		);
		assert.ok(
			result.plan.nextCommands.some((command) =>
				command.includes('package-sync:wasm-swift-from-plan:strict') &&
				command.includes(`--plan ${planPath}`) &&
				command.includes('--swift-version <version>') &&
				command.includes('--wasm-sdk-id <sdk-id>') &&
				command.includes('--source "<build provenance>"')
			)
		);
		assert.deepEqual(result.plan.nextCommands.slice(-4), [
			'pnpm run doctor:wasm-swift:candidate',
			'pnpm run verify:wasm-swift-candidate',
			'pnpm run doctor:wasm-swift:strict',
			'pnpm run verify:wasm-swift-readiness'
		]);
		assert.equal(result.plan.requiredTools.find((tool) => tool.tool === 'wasm-ld')?.ok, false);
		assert.deepEqual(JSON.parse(await readFile(planPath, 'utf8')), result.plan);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects native Swift/WASI baseline presets as browser compiler build commands', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-build-plan-command-'));
	try {
		const checkoutRoot = path.join(dir, 'checkout');
		await writeSwiftCheckoutFixture(checkoutRoot);

		await assert.rejects(
			() =>
				createSwiftBrowserCompilerBuildPlan({
					checkoutRoot,
					buildDir: path.join(dir, 'build'),
					planPath: path.join(dir, 'plan.json'),
					allowMissingTools: true,
					browserBuildCommand:
						'swift/utils/build-script --preset buildbot_linux_crosscompile_wasm',
					runTool: async (tool) => ({ tool, ok: true, version: `${tool} version` })
				}),
			/native Swift\/WASI baseline preset, not a browser compiler build command/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('can execute the recorded Swift browser build command after writing the plan', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-build-exec-'));
	try {
		const checkoutRoot = path.join(dir, 'checkout');
		const buildDir = path.join(dir, 'build');
		const rawRuntimeDir = path.join(dir, 'raw-runtime');
		const planPath = path.join(dir, 'plan.json');
		const browserBuildLog = path.join(dir, 'browser-build.log');
		await writeSwiftCheckoutFixture(checkoutRoot);

		const calls = [];
		const result = await runSwiftBrowserCompilerBuildHarness({
			checkoutRoot,
			buildDir,
			rawRuntimeDir,
			planPath,
			allowMissingTools: true,
			browserBuildCommand: './build-swift-browser.sh',
			browserBuildLog,
			executeBrowserBuildCommand: true,
			runTool: async (tool) => ({ tool, ok: true, version: `${tool} version` }),
			browserBuildCommandRunner: async (command, options) => {
				calls.push({ command, options });
				await writeFixture(path.join(options.buildDir, 'runner-worker.js'), '// runner\n');
			}
		});

		assert.equal(result.planPath, planPath);
		assert.equal(result.plan.browserCompilerBuild.execution.status, 'passed');
		assert.equal(result.plan.browserCompilerBuild.execution.command, './build-swift-browser.sh');
		assert.equal(result.plan.browserCompilerBuild.execution.cwd, checkoutRoot);
		assert.equal(result.plan.browserCompilerBuild.execution.buildDir, buildDir);
		assert.equal(result.plan.browserCompilerBuild.execution.rawRuntimeDir, rawRuntimeDir);
		assert.equal(result.plan.browserCompilerBuild.execution.planPath, planPath);
		assert.equal(result.plan.browserCompilerBuild.execution.logPath, browserBuildLog);
		assert.equal(result.plan.browserCompilerBuild.execution.exitCode, 0);
		assert.equal(typeof result.plan.browserCompilerBuild.execution.startedAt, 'string');
		assert.equal(typeof result.plan.browserCompilerBuild.execution.finishedAt, 'string');
		assert.deepEqual(calls, [
			{
				command: './build-swift-browser.sh',
				options: {
					cwd: checkoutRoot,
					env: {
						...process.env,
						WASM_SWIFT_BUILD_DIR: buildDir,
						WASM_SWIFT_RAW_RUNTIME_DIR: rawRuntimeDir,
						WASM_SWIFT_PLAN_PATH: planPath
					},
					buildDir,
					rawRuntimeDir,
					planPath,
					logPath: browserBuildLog
				}
			}
		]);
		assert.equal(JSON.parse(await readFile(planPath, 'utf8')).browserCompilerBuild.command, './build-swift-browser.sh');
		assert.equal(JSON.parse(await readFile(planPath, 'utf8')).browserCompilerBuild.execution.status, 'passed');
		assert.equal(await readFile(path.join(buildDir, 'runner-worker.js'), 'utf8'), '// runner\n');
		await assert.rejects(
			() =>
				runSwiftBrowserCompilerBuildHarness({
					checkoutRoot,
					buildDir,
					rawRuntimeDir,
					planPath,
					allowMissingTools: true,
					executeBrowserBuildCommand: true,
					runTool: async (tool) => ({ tool, ok: true })
				}),
			/--execute-browser-build-command requires --browser-build-command/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('records failed Swift browser build command executions before rethrowing', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-build-exec-fail-'));
	try {
		const checkoutRoot = path.join(dir, 'checkout');
		const buildDir = path.join(dir, 'build');
		const rawRuntimeDir = path.join(dir, 'raw-runtime');
		const planPath = path.join(dir, 'plan.json');
		const browserBuildLog = path.join(dir, 'browser-build.log');
		await writeSwiftCheckoutFixture(checkoutRoot);

		await assert.rejects(
			() =>
				runSwiftBrowserCompilerBuildHarness({
					checkoutRoot,
					buildDir,
					rawRuntimeDir,
					planPath,
					allowMissingTools: true,
					browserBuildCommand: './build-swift-browser.sh',
					browserBuildLog,
					executeBrowserBuildCommand: true,
					runTool: async (tool) => ({ tool, ok: true, version: `${tool} version` }),
					browserBuildCommandRunner: async () => {
						throw new Error('browser build failed');
					}
				}),
			/browser build failed/u
		);
		const plan = JSON.parse(await readFile(planPath, 'utf8'));
		assert.equal(plan.browserCompilerBuild.execution.status, 'failed');
		assert.equal(plan.browserCompilerBuild.execution.command, './build-swift-browser.sh');
		assert.equal(plan.browserCompilerBuild.execution.logPath, browserBuildLog);
		assert.equal(plan.browserCompilerBuild.execution.error, 'browser build failed');
		assert.equal(typeof plan.browserCompilerBuild.execution.startedAt, 'string');
		assert.equal(typeof plan.browserCompilerBuild.execution.finishedAt, 'string');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('tees executed Swift browser build command output into a log file', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-build-log-'));
	try {
		const checkoutRoot = path.join(dir, 'checkout');
		const buildDir = path.join(dir, 'build');
		const rawRuntimeDir = path.join(dir, 'raw-runtime');
		const planPath = path.join(dir, 'plan.json');
		const browserBuildLog = path.join(dir, 'logs', 'browser-build.log');
		await writeSwiftCheckoutFixture(checkoutRoot);
		await writeFile(
			path.join(checkoutRoot, 'build-swift-browser.sh'),
			'printf "swift stdout\\n"; printf "swift stderr\\n" >&2\n'
		);

		await runSwiftBrowserCompilerBuildHarness({
			checkoutRoot,
			buildDir,
			rawRuntimeDir,
			planPath,
			allowMissingTools: true,
			browserBuildCommand: 'sh ./build-swift-browser.sh',
			browserBuildLog,
			executeBrowserBuildCommand: true,
			runTool: async (tool) => ({ tool, ok: true, version: `${tool} version` })
		});

		const log = await readFile(browserBuildLog, 'utf8');
		assert.match(log, /\$ sh \.\/build-swift-browser\.sh/u);
		assert.match(log, /# cwd: /u);
		assert.match(log, /swift stdout/u);
		assert.match(log, /swift stderr/u);
		assert.match(log, /# exitCode: 0/u);
		const plan = JSON.parse(await readFile(planPath, 'utf8'));
		assert.equal(plan.browserCompilerBuild.execution.logPath, browserBuildLog);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('can discover and record Swift browser outputs after executing the build command', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-build-discover-'));
	try {
		const checkoutRoot = path.join(dir, 'checkout');
		const buildDir = path.join(dir, 'build');
		const rawRuntimeDir = path.join(dir, 'raw-runtime');
		const planPath = path.join(dir, 'plan.json');
		await writeSwiftCheckoutFixture(checkoutRoot);

		const result = await runSwiftBrowserCompilerBuildHarness({
			checkoutRoot,
			buildDir,
			rawRuntimeDir,
			planPath,
			allowMissingTools: true,
			browserBuildCommand: './build-swift-browser.sh',
			executeBrowserBuildCommand: true,
			discoverBuildOutputs: true,
			runTool: async (tool) => ({ tool, ok: true, version: `${tool} version` }),
			browserBuildCommandRunner: async (_command, options) => {
				await writeFixture(path.join(options.buildDir, 'runner-worker.js'), VALID_RUNNER_WORKER_SOURCE);
				await writeFixture(
					path.join(options.buildDir, 'swiftc.wasm'),
					taggedWasm('swiftc Swift compiler')
				);
				await writeFixture(
					path.join(options.buildDir, 'swiftpm.wasm'),
					taggedWasm('swiftpm SwiftPM')
				);
				await writeFixture(path.join(options.buildDir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES);
			}
		});

		assert.equal(result.discovery.ready, true);
		assert.deepEqual(result.discovery.missing, []);
		assert.deepEqual(result.plan.expectedOutputs, {
			'runner-worker.js': path.join(buildDir, 'runner-worker.js'),
			'swiftc.wasm': path.join(buildDir, 'swiftc.wasm'),
			'swiftpm.wasm': path.join(buildDir, 'swiftpm.wasm'),
			'sdk.tar.gz': path.join(buildDir, 'sdk.tar.gz')
		});
		assert.deepEqual(JSON.parse(await readFile(planPath, 'utf8')).expectedOutputs, result.plan.expectedOutputs);

		await assert.rejects(
			() =>
				runSwiftBrowserCompilerBuildHarness({
					checkoutRoot,
					buildDir: path.join(dir, 'missing-build'),
					rawRuntimeDir,
					planPath: path.join(dir, 'missing-plan.json'),
					allowMissingTools: true,
					discoverBuildOutputs: true,
					runTool: async (tool) => ({ tool, ok: true })
				}),
			/Swift browser compiler build directory was not found/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects incomplete checkout or missing build tools before writing a build plan', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-build-plan-invalid-'));
	try {
		await assert.rejects(
			() => createSwiftBrowserCompilerBuildPlan({ checkoutRoot: dir }),
			/Swift source checkout is incomplete/u
		);
		await writeSwiftCheckoutFixture(dir);
		await assert.rejects(
			() =>
				createSwiftBrowserCompilerBuildPlan({
					checkoutRoot: dir,
					requiredTools: ['python3', 'missing-tool'],
					runTool: async (tool) => ({ tool, ok: tool !== 'missing-tool' })
				}),
			/build tools are missing: missing-tool/u
		);
		const failedReceiptPath = path.join(dir, 'failed-bootstrap-receipt.json');
		await writeFixture(
			failedReceiptPath,
			`${JSON.stringify({
				format: 'wasm-idle-swift-source-bootstrap-receipt-v1',
				status: 'failed',
				sourceRoot: dir,
				checkout: { ok: false, missing: [path.join('swiftpm', 'Package.swift')] }
			})}\n`
		);
		await assert.rejects(
			() =>
				createSwiftBrowserCompilerBuildPlan({
					checkoutRoot: dir,
					sourceBootstrapReceipt: failedReceiptPath,
					allowMissingTools: true,
					runTool: async (tool) => ({ tool, ok: true })
				}),
			/source bootstrap receipt status must be passed/u
		);
		const otherReceiptPath = path.join(dir, 'other-bootstrap-receipt.json');
		await writeFixture(
			otherReceiptPath,
			`${JSON.stringify({
				format: 'wasm-idle-swift-source-bootstrap-receipt-v1',
				status: 'passed',
				sourceRoot: path.join(dir, 'other'),
				checkout: { ok: true, missing: [] }
			})}\n`
		);
		await assert.rejects(
			() =>
				createSwiftBrowserCompilerBuildPlan({
					checkoutRoot: dir,
					sourceBootstrapReceipt: otherReceiptPath,
					allowMissingTools: true,
					runTool: async (tool) => ({ tool, ok: true })
				}),
			/does not match checkout root/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
