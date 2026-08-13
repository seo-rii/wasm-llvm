import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
	assertSwiftContractCaseResult,
	buildSwiftWorkerRequest,
	collectSwiftWorkerResult,
	parseSwiftRuntimeContractRunnerArgs,
	resolveChromiumExecutable,
	validateSwiftRuntimeBundleInBrowser
} from './runtime-contract-runner.mjs';
import { SWIFT_RUNTIME_CONTRACT_CASES } from './runtime-contract.mjs';
import { createSwiftRuntimeBuildInfo } from './runtime-build-info.mjs';
import {
	buildFileEntries,
	createSwiftRuntimeManifest,
	fingerprintFileEntries
} from './runtime-manifest.mjs';

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

async function writeRuntimeBuildInfo(dir, overrides = {}) {
	await writeFile(
		path.join(dir, 'runtime-build.json'),
		`${JSON.stringify(
			{
				...createSwiftRuntimeBuildInfo({
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					source: 'unit-test-source'
				}),
				...overrides
			},
			null,
			2
		)}\n`,
		'utf8'
	);
}

async function writeRuntimeManifest(dir, overrides = {}) {
	const files = await buildFileEntries(dir);
	await writeFile(
		path.join(dir, 'runtime-manifest.v1.json'),
		`${JSON.stringify(
			{
				...createSwiftRuntimeManifest({
					files,
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					fingerprint: fingerprintFileEntries(files)
				}),
				...overrides
			},
			null,
			2
		)}\n`,
		'utf8'
	);
}

async function writeMinimalRuntimeFiles(dir) {
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, 'runner-worker.js'), 'self.onmessage = () => {};\n', 'utf8');
	await writeFile(path.join(dir, 'swiftc.wasm'), taggedWasm('swiftc Swift compiler'));
	await writeFile(path.join(dir, 'swiftpm.wasm'), taggedWasm('swiftpm SwiftPM'));
	await writeFile(path.join(dir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES);
}

test('builds Swift worker run requests from contract cases', () => {
	const testCase = SWIFT_RUNTIME_CONTRACT_CASES[0];
	const request = buildSwiftWorkerRequest(testCase, 'https://example.com/wasm-swift');

	assert.deepEqual(request, {
		run: true,
		baseUrl: 'https://example.com/wasm-swift/',
		manifestUrl: 'https://example.com/wasm-swift/runtime-manifest.v1.json',
		code: testCase.code,
		stdin: testCase.stdin,
		args: testCase.args,
		activePath: testCase.activePath,
		workspaceFiles: testCase.workspaceFiles,
		log: true
	});
});

test('parses and validates Swift browser contract runner CLI arguments', () => {
	assert.deepEqual(parseSwiftRuntimeContractRunnerArgs(['fixtures/swift', '--timeout-ms', '5000']), {
		bundleDir: path.resolve('fixtures/swift'),
		chromiumExecutable: '',
		timeoutMs: 5000
	});
	assert.deepEqual(
		parseSwiftRuntimeContractRunnerArgs([
			'--bundle-dir',
			'fixtures/swift',
			'--chromium-executable',
			'/usr/bin/chromium',
			'--timeout-ms',
			'10000'
		]),
		{
			bundleDir: path.resolve('fixtures/swift'),
			chromiumExecutable: '/usr/bin/chromium',
			timeoutMs: 10_000
		}
	);
	assert.throws(
		() => parseSwiftRuntimeContractRunnerArgs(['--bundle-dir']),
		/--bundle-dir requires a value/u
	);
	assert.throws(
		() => parseSwiftRuntimeContractRunnerArgs(['--chromium-executable', '--timeout-ms']),
		/--chromium-executable requires a value/u
	);
	for (const timeout of ['0', '-1', '1.5', 'abc']) {
		assert.throws(
			() => parseSwiftRuntimeContractRunnerArgs(['--timeout-ms', timeout]),
			/timeoutMs must be a positive safe integer/u
		);
	}
	assert.throws(
		() => parseSwiftRuntimeContractRunnerArgs(['--unknown']),
		/unknown argument/u
	);
	assert.throws(
		() => parseSwiftRuntimeContractRunnerArgs(['fixtures/one', 'fixtures/two']),
		/at most one bundleDir positional argument/u
	);
});

test('collects Swift worker output, diagnostics, completion, and errors', () => {
	assert.deepEqual(
		collectSwiftWorkerResult([
			{ progress: { percent: 10, stage: 'Compiling Swift' } },
			{ diagnostic: { message: 'warning' } },
			{ output: 'hello ' },
			{ output: 'swift\n' },
			{ results: true }
		]),
		{
			stdout: 'hello swift\n',
			diagnostics: [{ message: 'warning' }],
			completed: true,
			error: ''
		}
	);
	assert.deepEqual(collectSwiftWorkerResult([{ error: 'compile failed' }]), {
		stdout: '',
		diagnostics: [],
		completed: false,
		error: 'compile failed'
	});
});

test('asserts Swift contract case output exactly', () => {
	const testCase = SWIFT_RUNTIME_CONTRACT_CASES[0];
	assert.deepEqual(
		assertSwiftContractCaseResult(testCase, [
			{ output: testCase.expectedStdout },
			{ results: true }
		]),
		{
			stdout: testCase.expectedStdout,
			diagnostics: [],
			completed: true,
			error: ''
		}
	);
	assert.throws(
		() => assertSwiftContractCaseResult(testCase, [{ output: 'wrong\n' }, { results: true }]),
		/stdout mismatch/u
	);
	assert.throws(() => assertSwiftContractCaseResult(testCase, [{ error: 'boom' }]), /boom/u);
	assert.throws(
		() => assertSwiftContractCaseResult(testCase, [{ output: testCase.expectedStdout }]),
		/did not post/u
	);
	assert.deepEqual(
			assertSwiftContractCaseResult(
				{
					...testCase,
					name: 'compile-error',
					expectedStdout: '',
					expectError: true,
					expectedErrorPattern: 'Swift compiler failed'
				},
				[{ error: 'Swift compiler failed' }]
			),
		{
			stdout: '',
			diagnostics: [],
			completed: false,
			error: 'Swift compiler failed'
		}
	);
	assert.throws(
		() =>
			assertSwiftContractCaseResult(
				{
					...testCase,
					name: 'compile-error',
					expectedStdout: '',
					expectError: true,
					expectedErrorPattern: 'Swift compiler failed'
				},
				[{ results: true }]
			),
		/expected to fail/u
	);
	assert.throws(
		() =>
			assertSwiftContractCaseResult(
				{
					...testCase,
					name: 'compile-error',
					expectedStdout: '',
					expectError: true,
					expectedErrorPattern: 'Swift compiler failed'
				},
				[{ error: 'unknown Swift contract case' }]
			),
		/error mismatch/u
	);
});

test('validates custom Swift browser contract cases before reading bundle files', async () => {
	await assert.rejects(
		() =>
			validateSwiftRuntimeBundleInBrowser({
				bundleDir: '/missing/wasm-swift',
				chromiumExecutable: '/missing/chromium',
				cases: [
					{
						name: 'absolute-path',
						description: 'invalid absolute active path',
						activePath: '/tmp/main.swift',
						code: 'print("bad")\n',
						stdin: '',
						args: [],
						workspaceFiles: [],
						expectedStdout: ''
					}
				]
			}),
		/Swift browser runtime contract cases are invalid:[\s\S]*activePath must be a relative project path/u
	);
});

test('rejects browser contract bundles without runtime build metadata before launching Chromium', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-contract-buildinfo-'));
	try {
		await writeMinimalRuntimeFiles(dir);
		await writeRuntimeManifest(dir);

		await assert.rejects(
			() =>
				validateSwiftRuntimeBundleInBrowser({
					bundleDir: dir,
					chromiumExecutable: '/missing/chromium'
				}),
			/runtime build metadata could not be read/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects browser contract bundles without runtime build provenance before launching Chromium', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-contract-buildinfo-'));
	try {
		await writeMinimalRuntimeFiles(dir);
		await writeRuntimeManifest(dir);
		await writeRuntimeBuildInfo(dir, { source: '   ' });

		await assert.rejects(
			() =>
				validateSwiftRuntimeBundleInBrowser({
					bundleDir: dir,
					chromiumExecutable: '/missing/chromium'
				}),
			/source provenance is required/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects browser contract bundles when runtime build metadata differs from manifest', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-contract-buildinfo-'));
	try {
		await writeMinimalRuntimeFiles(dir);
		await writeRuntimeManifest(dir);
		await writeRuntimeBuildInfo(dir, {
			swiftVersion: '6.3.4',
			wasmSdkId: 'swift-6.3.4-RELEASE_wasm'
		});

		await assert.rejects(
			() =>
				validateSwiftRuntimeBundleInBrowser({
					bundleDir: dir,
					chromiumExecutable: '/missing/chromium'
				}),
			/swiftVersion 6\.3\.4 does not match manifest[\s\S]*wasmSdkId swift-6\.3\.4-RELEASE_wasm does not match manifest/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects browser contract bundles when SDK checksum metadata does not match archive bytes', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-contract-sdk-checksum-'));
	try {
		await writeMinimalRuntimeFiles(dir);
		await writeRuntimeManifest(dir);
		await writeRuntimeBuildInfo(dir, {
			wasmSdkUrl:
				'https://download.swift.org/swift-6.3.3-release/wasm-sdk/swift-6.3.3-RELEASE/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
			wasmSdkChecksum: 'd'.repeat(64)
		});

		await assert.rejects(
			() =>
				validateSwiftRuntimeBundleInBrowser({
					bundleDir: dir,
					chromiumExecutable: '/missing/chromium'
				}),
			/wasmSdkChecksum [a-f0-9]{64} does not match sdk\.tar\.gz sha256/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects browser contract workers that never request runtime assets', async (t) => {
	await resolveChromiumExecutable().catch((error) => {
		t.skip(error.message);
	});
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-contract-runner-no-assets-'));
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(
			path.join(dir, 'runner-worker.js'),
			`
self.onmessage = async (event) => {
	const { code, stdin, args = [], workspaceFiles = [] } = event.data || {};
	if (code.includes('let =')) {
		self.postMessage({ error: 'Swift compiler failed' });
		return;
	} else if (code.includes('second = readLine()')) {
		const lines = stdin.trimEnd().split('\\n');
		self.postMessage({ output: 'swift-stdin-lines:' + lines[0] + '|' + lines[1] + '\\n' });
	} else if (code.includes('readLine()')) {
		self.postMessage({ output: 'swift-stdin:' + stdin.trimEnd() + '\\n' });
	} else if (code.includes('CommandLine.arguments')) {
		self.postMessage({ output: args.join(',') + '\\n' });
	} else if (workspaceFiles.some((file) => file.path === 'Sources/Helper.swift')) {
		self.postMessage({ output: 'workspace-ok\\n' });
	} else {
		self.postMessage({ error: 'unexpected contract fixture input' });
		return;
	}
	self.postMessage({ results: true });
};
`,
			'utf8'
		);
		await writeFile(path.join(dir, 'swiftc.wasm'), taggedWasm('swiftc Swift compiler'));
		await writeFile(path.join(dir, 'swiftpm.wasm'), taggedWasm('swiftpm SwiftPM'));
		await writeFile(path.join(dir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES);
		await writeRuntimeBuildInfo(dir);
		await writeRuntimeManifest(dir);

		await assert.rejects(
			() =>
				validateSwiftRuntimeBundleInBrowser({
					bundleDir: dir,
					timeoutMs: 10_000
				}),
			/did not request required runtime assets/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('runs Swift contract cases through a browser worker fixture', async (t) => {
	await resolveChromiumExecutable().catch((error) => {
		t.skip(error.message);
	});
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-contract-runner-'));
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(
			path.join(dir, 'runner-worker.js'),
			`
self.onmessage = async (event) => {
	const { baseUrl, manifestUrl, code, stdin, args = [], workspaceFiles = [] } = event.data || {};
	if (!self.crossOriginIsolated) {
		self.postMessage({ error: 'Swift contract fixture was not cross-origin isolated' });
		return;
	}
	const manifest = await (await fetch(manifestUrl)).json();
	const swiftc = new Uint8Array(await (await fetch(new URL('swiftc.wasm', baseUrl))).arrayBuffer());
	const swiftpm = new Uint8Array(await (await fetch(new URL('swiftpm.wasm', baseUrl))).arrayBuffer());
	const sdk = new Uint8Array(await (await fetch(new URL('sdk.tar.gz', baseUrl))).arrayBuffer());
	if (
		manifest.runtime !== 'Swift' ||
		swiftc[0] !== 0 ||
		swiftpm[0] !== 0 ||
		sdk[0] !== 31
	) {
		self.postMessage({ error: 'Swift runtime assets failed to load' });
		return;
	}
	if (code.includes('let =')) {
		self.postMessage({ error: 'Swift compiler failed' });
		return;
	} else if (code.includes('second = readLine()')) {
		const lines = stdin.trimEnd().split('\\n');
		self.postMessage({ output: 'swift-stdin-lines:' + lines[0] + '|' + lines[1] + '\\n' });
	} else if (code.includes('readLine()')) {
		self.postMessage({ output: 'swift-stdin:' + stdin.trimEnd() + '\\n' });
	} else if (code.includes('CommandLine.arguments')) {
		self.postMessage({ output: args.join(',') + '\\n' });
	} else if (workspaceFiles.some((file) => file.path === 'Sources/Helper.swift')) {
		self.postMessage({ output: 'workspace-ok\\n' });
	} else {
		self.postMessage({ error: 'unexpected contract fixture input' });
		return;
	}
	self.postMessage({ results: true });
};
`,
			'utf8'
		);
		await writeFile(path.join(dir, 'swiftc.wasm'), taggedWasm('swiftc Swift compiler'));
		await writeFile(path.join(dir, 'swiftpm.wasm'), taggedWasm('swiftpm SwiftPM'));
		await writeFile(path.join(dir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES);
		await writeRuntimeBuildInfo(dir);
		await writeRuntimeManifest(dir);

		const result = await validateSwiftRuntimeBundleInBrowser({
			bundleDir: dir,
			timeoutMs: 10_000
		});

		assert.deepEqual(
			result.results.map((entry) => ({ name: entry.name, stdout: entry.stdout })),
			SWIFT_RUNTIME_CONTRACT_CASES.map((testCase) => ({
				name: testCase.name,
				stdout: testCase.expectedStdout
			}))
		);
		assert.deepEqual(
			Object.keys(result.workerAssetRequests).sort(),
			['runtime-manifest.v1.json', 'sdk.tar.gz', 'swiftc.wasm', 'swiftpm.wasm'].sort()
		);
		for (const count of Object.values(result.workerAssetRequests)) {
			assert.equal(count >= 1, true);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('runs Swift browser contract when compiler wasm assets are gzip-only', async (t) => {
	await resolveChromiumExecutable().catch((error) => {
		t.skip(error.message);
	});
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-contract-runner-gzip-'));
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(
			path.join(dir, 'runner-worker.js'),
			`
self.onmessage = async (event) => {
	const { baseUrl, manifestUrl, code, stdin, args = [], workspaceFiles = [] } = event.data || {};
	if (!self.crossOriginIsolated) {
		self.postMessage({ error: 'Swift contract fixture was not cross-origin isolated' });
		return;
	}
	const manifest = await (await fetch(manifestUrl)).json();
	const swiftc = new Uint8Array(await (await fetch(new URL('swiftc.wasm', baseUrl))).arrayBuffer());
	const swiftpm = new Uint8Array(await (await fetch(new URL('swiftpm.wasm', baseUrl))).arrayBuffer());
	const sdk = new Uint8Array(await (await fetch(new URL('sdk.tar.gz', baseUrl))).arrayBuffer());
	if (
		manifest.runtime !== 'Swift' ||
		swiftc[0] !== 0 ||
		swiftc[1] !== 97 ||
		swiftc[2] !== 115 ||
		swiftc[3] !== 109 ||
		swiftpm[0] !== 0 ||
		sdk[0] !== 31
	) {
		self.postMessage({ error: 'swiftc wasm fallback failed' });
		return;
	}
	if (code.includes('let =')) {
		self.postMessage({ error: 'Swift compiler failed' });
		return;
	} else if (code.includes('second = readLine()')) {
		const lines = stdin.trimEnd().split('\\n');
		self.postMessage({ output: 'swift-stdin-lines:' + lines[0] + '|' + lines[1] + '\\n' });
	} else if (code.includes('readLine()')) {
		self.postMessage({ output: 'swift-stdin:' + stdin.trimEnd() + '\\n' });
	} else if (code.includes('CommandLine.arguments')) {
		self.postMessage({ output: args.join(',') + '\\n' });
	} else if (workspaceFiles.some((file) => file.path === 'Sources/Helper.swift')) {
		self.postMessage({ output: 'workspace-ok\\n' });
	} else {
		self.postMessage({ error: 'unexpected contract fixture input' });
		return;
	}
	self.postMessage({ results: true });
};
`,
			'utf8'
		);
		await writeFile(path.join(dir, 'swiftc.wasm'), taggedWasm('swiftc Swift compiler'));
		await writeFile(path.join(dir, 'swiftpm.wasm'), taggedWasm('swiftpm SwiftPM'));
		await writeFile(path.join(dir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES);
		await writeRuntimeBuildInfo(dir);
		await writeRuntimeManifest(dir);
		await writeFile(
			`${path.join(dir, 'swiftc.wasm')}.gz`,
			gzipSync(await readFile(path.join(dir, 'swiftc.wasm')))
		);
		await writeFile(
			`${path.join(dir, 'swiftpm.wasm')}.gz`,
			gzipSync(await readFile(path.join(dir, 'swiftpm.wasm')))
		);
		await rm(path.join(dir, 'swiftc.wasm'));
		await rm(path.join(dir, 'swiftpm.wasm'));

		const result = await validateSwiftRuntimeBundleInBrowser({
			bundleDir: dir,
			timeoutMs: 10_000
		});

		assert.deepEqual(
			result.results.map((entry) => ({ name: entry.name, stdout: entry.stdout })),
			SWIFT_RUNTIME_CONTRACT_CASES.map((testCase) => ({
				name: testCase.name,
				stdout: testCase.expectedStdout
			}))
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
