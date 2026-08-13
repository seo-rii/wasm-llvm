import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
	EXPECTED_MANIFEST_RUNTIME_CONTRACT,
	REQUIRED_RUNTIME_FILES,
	SWIFT_RUNTIME_MANIFEST_FORMAT,
	buildFileEntries,
	createSwiftRuntimeManifest,
	fingerprintFileEntries,
	validateSwiftRunnerWorkerSource,
	validateSwiftCompilerWasmModuleBytes,
	validateSwiftRuntimeFileSignatures,
	validateSwiftRuntimeManifest,
	validateSwiftRuntimeManifestFiles,
	validateSwiftSdkArchiveBytes,
	validateSwiftWasmModuleBytes
} from './runtime-manifest.mjs';

const VALID_RUNNER_WORKER_SOURCE = `
self.onmessage = async (event) => {
	const { run, baseUrl, manifestUrl, code, stdin, args, activePath, workspaceFiles } =
		event.data || {};
	const manifest = await (await fetch(manifestUrl)).json();
	const swiftcUrl = new URL('swiftc.wasm', baseUrl).href;
	const swiftpmUrl = new URL('swiftpm.wasm', baseUrl).href;
	const sdkUrl = new URL('sdk.tar.gz', baseUrl).href;
	self.postMessage({ progress: { percent: 50, stage: 'Compiling Swift' } });
	self.postMessage({
		output: [run, baseUrl, manifestUrl, code, stdin, args, activePath, workspaceFiles, manifest.runtime, swiftcUrl, swiftpmUrl, sdkUrl].join('\\n')
	});
	self.postMessage({ results: true });
	self.postMessage({ error: '' });
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

async function writeValidSwiftRuntimeFile(dir, relativePath) {
	if (relativePath === 'runner-worker.js') {
		await writeFile(path.join(dir, relativePath), VALID_RUNNER_WORKER_SOURCE);
		return;
	}
	if (relativePath.endsWith('.wasm')) {
		await writeFile(
			path.join(dir, relativePath),
			relativePath === 'swiftc.wasm'
				? taggedWasm('swiftc Swift compiler')
				: taggedWasm('swiftpm SwiftPM')
		);
		return;
	}
	if (relativePath === 'sdk.tar.gz') {
		await writeFile(path.join(dir, relativePath), VALID_SDK_ARCHIVE_BYTES);
		return;
	}
	throw new Error(`unknown Swift runtime fixture file ${relativePath}`);
}

test('creates and validates a Swift runtime manifest', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-manifest-'));
	try {
		await mkdir(path.join(dir, 'nested'), { recursive: true });
		for (const file of REQUIRED_RUNTIME_FILES) {
			await writeValidSwiftRuntimeFile(dir, file);
		}
		const files = await buildFileEntries(dir);
		const manifest = createSwiftRuntimeManifest({
			files,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			fingerprint: fingerprintFileEntries(files)
		});
		assert.equal(manifest.format, SWIFT_RUNTIME_MANIFEST_FORMAT);
		assert.deepEqual(manifest.runtimeContract, EXPECTED_MANIFEST_RUNTIME_CONTRACT);
		assert.deepEqual(validateSwiftRuntimeManifest(manifest), []);
		assert.deepEqual(await validateSwiftRuntimeManifestFiles(dir, manifest), []);
		assert.equal(manifest.files.length, REQUIRED_RUNTIME_FILES.length);
		for (const file of manifest.files) {
			assert.match(file.sha256, /^[a-f0-9]{64}$/u);
			assert.equal(typeof file.bytes, 'number');
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects unsafe runtime manifest file entry paths before hashing', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-manifest-paths-'));
	try {
		for (const file of REQUIRED_RUNTIME_FILES) {
			await writeValidSwiftRuntimeFile(dir, file);
		}

		await assert.rejects(
			() => buildFileEntries(dir, ['../swiftc.wasm']),
			/non-empty relative path/u
		);
		await assert.rejects(
			() => buildFileEntries(dir, ['/tmp/swiftc.wasm']),
			/non-empty relative path/u
		);
		await assert.rejects(
			() => buildFileEntries(dir, ['C:\\\\tmp\\\\swiftc.wasm']),
			/non-empty relative path/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('validates Swift runtime manifest file sizes and hashes against the bundle', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-manifest-integrity-'));
	try {
		for (const file of REQUIRED_RUNTIME_FILES) {
			await writeValidSwiftRuntimeFile(dir, file);
		}
		const files = await buildFileEntries(dir);
		const manifest = createSwiftRuntimeManifest({
			files,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			fingerprint: fingerprintFileEntries(files)
		});
		await writeFile(path.join(dir, 'swiftc.wasm'), 'changed');

		assert.deepEqual(await validateSwiftRuntimeManifestFiles(dir, manifest), [
			'swiftc.wasm must start with the WebAssembly binary magic header',
			`swiftc.wasm bytes mismatch: manifest ${files.find((file) => file.path === 'swiftc.wasm').bytes}, actual 7`,
			'swiftc.wasm sha256 mismatch'
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('validates Swift runtime manifest fingerprint against file entries', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-manifest-fingerprint-'));
	try {
		for (const file of REQUIRED_RUNTIME_FILES) {
			await writeValidSwiftRuntimeFile(dir, file);
		}
		const files = await buildFileEntries(dir);
		const manifest = createSwiftRuntimeManifest({
			files,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			fingerprint: '0123456789abcdef'
		});

		assert.deepEqual(await validateSwiftRuntimeManifestFiles(dir, manifest), [
			`fingerprint mismatch: manifest 0123456789abcdef, expected ${fingerprintFileEntries(files)}`
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('validates gzip-only compressed Swift compiler wasm files against the uncompressed manifest', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-manifest-compressed-'));
	try {
		for (const file of REQUIRED_RUNTIME_FILES) {
			await writeValidSwiftRuntimeFile(dir, file);
		}
		const files = await buildFileEntries(dir);
		const manifest = createSwiftRuntimeManifest({
			files,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			fingerprint: fingerprintFileEntries(files)
		});
		for (const wasmFile of ['swiftc.wasm', 'swiftpm.wasm']) {
			const wasmPath = path.join(dir, wasmFile);
			await writeFile(`${wasmPath}.gz`, gzipSync(await readFile(wasmPath)));
			await rm(wasmPath);
		}

		assert.deepEqual(await validateSwiftRuntimeManifestFiles(dir, manifest), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('reports corrupt gzip-only Swift compiler wasm files distinctly', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-manifest-corrupt-gzip-'));
	try {
		for (const file of REQUIRED_RUNTIME_FILES) {
			await writeValidSwiftRuntimeFile(dir, file);
		}
		const files = await buildFileEntries(dir);
		const manifest = createSwiftRuntimeManifest({
			files,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			fingerprint: fingerprintFileEntries(files)
		});
		await writeFile(path.join(dir, 'swiftc.wasm.gz'), 'not gzip');
		await rm(path.join(dir, 'swiftc.wasm'));

		const errors = await validateSwiftRuntimeManifestFiles(dir, manifest);
		assert.equal(
			errors.filter((error) => /swiftc\.wasm\.gz could not be decompressed/u.test(error))
				.length,
			2
		);
		assert.ok(errors.every((error) => !/swiftc\.wasm was not found/u.test(error)));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('validates Swift compiler wasm and SDK archive signatures', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-signatures-'));
	try {
		await writeFile(path.join(dir, 'swiftc.wasm'), 'not wasm');
		await writeFile(path.join(dir, 'swiftpm.wasm'), taggedWasm('swiftpm SwiftPM'));
		await writeFile(path.join(dir, 'sdk.tar.gz'), 'not gzip');

		assert.deepEqual(await validateSwiftRuntimeFileSignatures(dir), [
			'swiftc.wasm must start with the WebAssembly binary magic header',
			'sdk.tar.gz must be a gzip-compressed archive'
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects Swift compiler wasm files that only fake the magic header', async () => {
	const invalidModule = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1);
	const moduleErrors = await validateSwiftWasmModuleBytes(invalidModule, 'swiftc.wasm');
	assert.equal(moduleErrors.length, 1);
	assert.match(moduleErrors[0], /swiftc\.wasm must be a valid WebAssembly module/u);

	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-invalid-module-'));
	try {
		await writeFile(path.join(dir, 'swiftc.wasm'), invalidModule);
		await writeFile(path.join(dir, 'swiftpm.wasm'), taggedWasm('swiftpm SwiftPM'));
		await writeFile(path.join(dir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES);

		const signatureErrors = await validateSwiftRuntimeFileSignatures(dir);
		assert.equal(signatureErrors.length, 1);
		assert.match(signatureErrors[0], /swiftc\.wasm must be a valid WebAssembly module/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('validates Swift compiler wasm identity metadata for build outputs', async () => {
	assert.deepEqual(
		await validateSwiftCompilerWasmModuleBytes(taggedWasm('swiftc Swift compiler'), 'swiftc.wasm'),
		[]
	);
	assert.deepEqual(
		await validateSwiftCompilerWasmModuleBytes(taggedWasm('swiftpm SwiftPM'), 'swiftpm.wasm'),
		[]
	);
	assert.deepEqual(
		await validateSwiftCompilerWasmModuleBytes(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0), 'swiftc.wasm'),
		[
			'swiftc.wasm must contain Swift compiler or SwiftPM identity metadata',
			'swiftc.wasm must identify a Swift compiler artifact'
		]
	);
	assert.deepEqual(
		await validateSwiftCompilerWasmModuleBytes(taggedWasm('swiftc Swift compiler'), 'swiftpm.wasm'),
		['swiftpm.wasm must identify a SwiftPM artifact']
	);
});

test('rejects Swift SDK archives that only fake the gzip magic header', () => {
	assert.deepEqual(validateSwiftSdkArchiveBytes(Uint8Array.of(31, 139, 8), 'sdk.tar.gz'), [
		'sdk.tar.gz must be a valid gzip archive: unexpected end of file'
	]);
	assert.deepEqual(validateSwiftSdkArchiveBytes(Uint8Array.of(80, 75, 3, 4), 'sdk.tar.gz'), [
		'sdk.tar.gz must be a gzip-compressed archive, not a SwiftWasm .artifactbundle.zip file'
	]);
	assert.deepEqual(validateSwiftSdkArchiveBytes(VALID_SDK_ARCHIVE_BYTES, 'sdk.tar.gz'), []);
});

test('reports missing required compiler bundle files', () => {
	const manifest = createSwiftRuntimeManifest({
		files: [{ path: 'runner-worker.js', bytes: 10, sha256: 'a'.repeat(64) }],
		swiftVersion: '6.3.3',
		wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
		fingerprint: '0123456789abcdef'
	});
	assert.deepEqual(validateSwiftRuntimeManifest(manifest), [
		'missing required runtime file swiftc.wasm',
		'missing required runtime file swiftpm.wasm',
		'missing required runtime file sdk.tar.gz'
	]);
});

test('rejects non-object Swift runtime manifests', () => {
	assert.deepEqual(validateSwiftRuntimeManifest(null), ['manifest must be an object']);
	assert.deepEqual(validateSwiftRuntimeManifest([]), ['manifest must be an object']);
});

test('rejects duplicate runtime manifest file paths', () => {
	const manifest = createSwiftRuntimeManifest({
		files: [
			{ path: 'runner-worker.js', bytes: 10, sha256: 'a'.repeat(64) },
			{ path: 'runner-worker.js', bytes: 10, sha256: 'a'.repeat(64) },
			{ path: 'swiftc.wasm', bytes: 10, sha256: 'a'.repeat(64) },
			{ path: 'swiftpm.wasm', bytes: 10, sha256: 'a'.repeat(64) },
			{ path: 'sdk.tar.gz', bytes: 10, sha256: 'a'.repeat(64) }
		],
		swiftVersion: '6.3.3',
		wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
		fingerprint: '0123456789abcdef'
	});

	assert.deepEqual(validateSwiftRuntimeManifest(manifest), [
		'files[1].path duplicates runner-worker.js'
	]);
});

test('rejects malformed file metadata', () => {
	const errors = validateSwiftRuntimeManifest({
		format: SWIFT_RUNTIME_MANIFEST_FORMAT,
		runtime: 'Swift',
		swiftVersion: '6.3.3',
		wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
		fingerprint: 'not-a-fingerprint',
		files: [{ path: '/absolute.wasm', bytes: 0, sha256: 'xyz' }]
	});
	assert.deepEqual(errors, [
		'runtimeContract must describe the Swift browser runtime contract',
		'fingerprint must be a 16-character lowercase hex string',
		'files[0].path must be a non-empty relative path',
		'files[0].bytes must be a positive safe integer',
		'files[0].sha256 must be a lowercase sha256 hex digest',
		'missing required runtime file runner-worker.js',
		'missing required runtime file swiftc.wasm',
		'missing required runtime file swiftpm.wasm',
		'missing required runtime file sdk.tar.gz'
	]);
});

test('rejects malformed Swift runtime manifest metadata', () => {
	const errors = validateSwiftRuntimeManifest({
		format: SWIFT_RUNTIME_MANIFEST_FORMAT,
		runtime: 'Swift',
		swiftVersion: 'nightly',
		wasmSdkId: 'swift-6.3.3-RELEASE',
		runtimeContract: { format: 'old', version: 0 },
		fingerprint: '0123456789abcdef',
		files: [
			{ path: 'runner-worker.js', bytes: 10, sha256: 'a'.repeat(64) },
			{ path: 'swiftc.wasm', bytes: 10, sha256: 'a'.repeat(64) },
			{ path: 'swiftpm.wasm', bytes: 10, sha256: 'a'.repeat(64) },
			{ path: 'sdk.tar.gz', bytes: 10, sha256: 'a'.repeat(64) }
		]
	});

	assert.deepEqual(errors, [
		'swiftVersion must be a Swift release version string such as 6.3.3',
		'wasmSdkId must name a Swift Wasm SDK ending in _wasm',
		'runtimeContract.format must be wasm-swift-runtime-contract-v1',
		'runtimeContract.version must be 2'
	]);
});

test('rejects Windows absolute runtime manifest file paths', () => {
	const errors = validateSwiftRuntimeManifest({
		format: SWIFT_RUNTIME_MANIFEST_FORMAT,
		runtime: 'Swift',
		swiftVersion: '6.3.3',
		wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
		runtimeContract: EXPECTED_MANIFEST_RUNTIME_CONTRACT,
		fingerprint: '0123456789abcdef',
		files: [
			{ path: 'runner-worker.js', bytes: 10, sha256: 'a'.repeat(64) },
			{ path: 'C:\\\\tmp\\\\swiftc.wasm', bytes: 10, sha256: 'a'.repeat(64) },
			{ path: 'swiftpm.wasm', bytes: 10, sha256: 'a'.repeat(64) },
			{ path: 'sdk.tar.gz', bytes: 10, sha256: 'a'.repeat(64) }
		]
	});

	assert.deepEqual(errors, [
		'files[1].path must be a non-empty relative path',
		'missing required runtime file swiftc.wasm'
	]);
});

test('reports Swift manifest CLI argument errors without stack traces', async () => {
	const { spawnSync } = await import('node:child_process');
	const scriptPath = path.resolve(import.meta.dirname, 'runtime-manifest.mjs');
	const unknownOption = spawnSync(process.execPath, [scriptPath, '--unknown'], {
		encoding: 'utf8'
	});
	const tooMany = spawnSync(process.execPath, [scriptPath, 'one.json', 'two.json'], {
		encoding: 'utf8'
	});

	assert.notEqual(unknownOption.status, 0);
	assert.match(unknownOption.stderr, /Unknown option: --unknown/u);
	assert.doesNotMatch(unknownOption.stderr, /\n\s+at /u);
	assert.notEqual(tooMany.status, 0);
	assert.match(tooMany.stderr, /at most one manifest path argument/u);
	assert.doesNotMatch(tooMany.stderr, /\n\s+at /u);
});

test('validates the Swift runner worker playground message contract', () => {
	assert.deepEqual(validateSwiftRunnerWorkerSource(VALID_RUNNER_WORKER_SOURCE), []);
	assert.deepEqual(validateSwiftRunnerWorkerSource('self.onmessage = () => {};'), [
		'runner-worker.js must read run from run messages',
		'runner-worker.js must read baseUrl from run messages',
		'runner-worker.js must read manifestUrl from run messages',
		'runner-worker.js must read code from run messages',
		'runner-worker.js must read stdin from run messages',
		'runner-worker.js must read args from run messages',
		'runner-worker.js must read activePath from run messages',
		'runner-worker.js must read workspaceFiles from run messages',
		'runner-worker.js must post worker responses',
		'runner-worker.js must fetch manifestUrl',
		'runner-worker.js must parse the runtime manifest as JSON',
		'runner-worker.js must be able to post output responses',
		'runner-worker.js must be able to post results responses',
		'runner-worker.js must be able to post error responses',
		'runner-worker.js must be able to post progress responses',
		'runner-worker.js must reference swiftc.wasm',
		'runner-worker.js must reference swiftpm.wasm',
		'runner-worker.js must reference sdk.tar.gz'
	]);
});
