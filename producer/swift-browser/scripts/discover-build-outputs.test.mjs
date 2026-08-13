import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
	discoverSwiftBrowserBuildOutputs,
	parseDiscoverBuildOutputsArgs,
	writeDiscoveredOutputsToPlan
} from './discover-build-outputs.mjs';

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

test('parses Swift build output discovery arguments', () => {
	assert.deepEqual(parseDiscoverBuildOutputsArgs(['--help']), { help: true });
	assert.deepEqual(parseDiscoverBuildOutputsArgs([]), {
		buildDir: path.resolve(import.meta.dirname, '..', 'browser-compiler-build'),
		planPath: path.resolve(
			import.meta.dirname,
			'..',
			'browser-compiler-build',
			'wasm-idle-swift-browser-build-plan.json'
		),
		writePlan: false,
		allowOfficialSdkPlaceholder: false,
		json: false
	});
	assert.deepEqual(
		parseDiscoverBuildOutputsArgs([
			'--build-dir',
			'build',
			'--plan',
			'plan.json',
			'--write-plan',
			'--allow-official-sdk-placeholder',
			'--json'
		]),
		{
			buildDir: path.resolve('build'),
			planPath: path.resolve('plan.json'),
			writePlan: true,
			allowOfficialSdkPlaceholder: true,
			json: true
		}
	);
	assert.throws(() => parseDiscoverBuildOutputsArgs(['--build-dir']), /--build-dir requires a value/u);
	assert.throws(() => parseDiscoverBuildOutputsArgs(['--unknown']), /Unknown option/u);
});

test('discovers valid Swift browser compiler output candidates', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-discover-outputs-'));
	try {
		const buildDir = path.join(dir, 'build');
		const runnerPath = await writeFixture(
			path.join(buildDir, 'workers', 'runner-worker.js'),
			VALID_RUNNER_WORKER_SOURCE
		);
		const swiftcPath = await writeFixture(
			path.join(buildDir, 'bin', 'swiftc.wasm'),
			taggedWasm('swiftc Swift compiler')
		);
		const swiftpmPath = await writeFixture(
			path.join(buildDir, 'bin', 'swiftpm.wasm'),
			taggedWasm('swiftpm SwiftPM')
		);
		const sdkPath = await writeFixture(
			path.join(buildDir, 'sdk', 'sdk.tar.gz'),
			VALID_SDK_ARCHIVE_BYTES
		);
		await writeFixture(path.join(buildDir, 'bin', 'not-swiftc.wasm'), 'not wasm');

		const discovery = await discoverSwiftBrowserBuildOutputs({ buildDir });

		assert.equal(discovery.ready, true);
		assert.deepEqual(discovery.missing, []);
		assert.deepEqual(discovery.validationErrors, {
			'runner-worker.js': [],
			'swiftc.wasm': [],
			'swiftpm.wasm': [],
			'sdk.tar.gz': []
		});
		assert.deepEqual(discovery.expectedOutputs, {
			'runner-worker.js': runnerPath,
			'swiftc.wasm': swiftcPath,
			'swiftpm.wasm': swiftpmPath,
			'sdk.tar.gz': sdkPath
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('reports missing outputs and can use the official SDK placeholder', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-discover-missing-'));
	try {
		const buildDir = path.join(dir, 'build');
		await writeFixture(
			path.join(buildDir, 'runner-worker.js'),
			VALID_RUNNER_WORKER_SOURCE
		);
		await writeFixture(
			path.join(buildDir, 'swiftc.wasm'),
			taggedWasm('swiftc Swift compiler')
		);
		await writeFixture(
			path.join(buildDir, 'swiftpm.wasm'),
			taggedWasm('swiftpm SwiftPM')
		);

		const discovery = await discoverSwiftBrowserBuildOutputs({
			buildDir,
			allowOfficialSdkPlaceholder: true
		});

		assert.equal(discovery.ready, true);
		assert.equal(discovery.expectedOutputs['sdk.tar.gz'], 'official-swift-wasm-sdk');
		assert.deepEqual(discovery.validationErrors['sdk.tar.gz'], []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('does not discover Swift compiler wasm candidates that fail module compilation', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-discover-invalid-wasm-'));
	try {
		const buildDir = path.join(dir, 'build');
		await writeFixture(
			path.join(buildDir, 'runner-worker.js'),
			VALID_RUNNER_WORKER_SOURCE
		);
		await writeFixture(
			path.join(buildDir, 'swiftc.wasm'),
			Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1)
		);
		await writeFixture(
			path.join(buildDir, 'swiftpm.wasm'),
			taggedWasm('swiftpm SwiftPM')
		);
		await writeFixture(path.join(buildDir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES);

		const discovery = await discoverSwiftBrowserBuildOutputs({ buildDir });

		assert.equal(discovery.ready, false);
		assert.deepEqual(discovery.missing, ['swiftc.wasm']);
		assert.equal(discovery.expectedOutputs['swiftc.wasm'], null);
		assert.deepEqual(discovery.candidates['swiftc.wasm'], [path.join(buildDir, 'swiftc.wasm')]);
		assert.equal(discovery.validationErrors['swiftc.wasm'][0].path, path.join(buildDir, 'swiftc.wasm'));
		assert.match(
			discovery.validationErrors['swiftc.wasm'][0].errors[0],
			/swiftc\.wasm must be a valid WebAssembly module/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('reports Swift browser compiler candidate validation errors', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-discover-validation-errors-'));
	try {
		const buildDir = path.join(dir, 'build');
		await writeFixture(
			path.join(buildDir, 'runner-worker.js'),
			VALID_RUNNER_WORKER_SOURCE
		);
		await writeFixture(
			path.join(buildDir, 'swiftc.wasm'),
			Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)
		);
		await writeFixture(
			path.join(buildDir, 'swiftpm.wasm'),
			taggedWasm('swiftpm SwiftPM')
		);
		await writeFixture(path.join(buildDir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES);

		const discovery = await discoverSwiftBrowserBuildOutputs({ buildDir });

		assert.equal(discovery.ready, false);
		assert.deepEqual(discovery.missing, ['swiftc.wasm']);
		assert.deepEqual(discovery.validationErrors['swiftc.wasm'], [
			{
				path: path.join(buildDir, 'swiftc.wasm'),
				errors: [
					'swiftc.wasm must contain Swift compiler or SwiftPM identity metadata',
					'swiftc.wasm must identify a Swift compiler artifact'
				]
			}
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('writes discovered outputs back into a Swift browser build plan', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-discover-plan-'));
	try {
		const buildDir = path.join(dir, 'build');
		const planPath = path.join(buildDir, 'plan.json');
		const runnerPath = await writeFixture(
			path.join(buildDir, 'runner-worker.js'),
			VALID_RUNNER_WORKER_SOURCE
		);
		const swiftcPath = await writeFixture(
			path.join(buildDir, 'swiftc.wasm'),
			taggedWasm('swiftc Swift compiler')
		);
		const swiftpmPath = await writeFixture(
			path.join(buildDir, 'swiftpm.wasm'),
			taggedWasm('swiftpm SwiftPM')
		);
		await writeFixture(
			planPath,
			`${JSON.stringify(
				{
					format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
					buildDir,
					rawRuntimeDir: path.join(dir, 'raw-runtime'),
					expectedOutputs: {},
					browserCompilerBuild: {
						requiredOutputs: [
							{ name: 'runner-worker.js', expectedPath: path.join(dir, 'old-runner-worker.js') },
							{ name: 'swiftc.wasm', expectedPath: path.join(dir, 'old-swiftc.wasm') },
							{ name: 'swiftpm.wasm', expectedPath: path.join(dir, 'old-swiftpm.wasm') },
							{ name: 'sdk.tar.gz', expectedPath: path.join(dir, 'old-sdk.tar.gz') },
							{ name: 'diagnostics.txt', expectedPath: path.join(dir, 'diagnostics.txt') }
						]
					}
				},
				null,
				2
			)}\n`
		);
		const discovery = await discoverSwiftBrowserBuildOutputs({
			buildDir,
			allowOfficialSdkPlaceholder: true
		});

		const result = await writeDiscoveredOutputsToPlan({ planPath, discovery });
		const updated = JSON.parse(await readFile(planPath, 'utf8'));

		assert.equal(result.planPath, planPath);
		assert.deepEqual(updated.expectedOutputs, {
			'runner-worker.js': runnerPath,
			'swiftc.wasm': swiftcPath,
			'swiftpm.wasm': swiftpmPath,
			'sdk.tar.gz': 'official-swift-wasm-sdk'
		});
		assert.deepEqual(updated.browserCompilerBuild.requiredOutputs, [
			{ name: 'runner-worker.js', expectedPath: runnerPath },
			{ name: 'swiftc.wasm', expectedPath: swiftcPath },
			{ name: 'swiftpm.wasm', expectedPath: swiftpmPath },
			{ name: 'sdk.tar.gz', expectedPath: 'official-swift-wasm-sdk' },
			{ name: 'diagnostics.txt', expectedPath: path.join(dir, 'diagnostics.txt') }
		]);
		assert.deepEqual(updated.discoveredOutputs.missing, []);
		assert.deepEqual(updated.discoveredOutputs.validationErrors, {
			'runner-worker.js': [],
			'swiftc.wasm': [],
			'swiftpm.wasm': [],
			'sdk.tar.gz': []
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
