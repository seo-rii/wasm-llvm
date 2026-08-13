import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import {
	fetchSwiftWasmSdkArtifact,
	parseFetchOfficialSdkArgs,
	validateSwiftWasmSdkArtifactUrl
} from './fetch-official-sdk.mjs';
import {
	OFFICIAL_WASM_SDK_CHECKSUM,
	OFFICIAL_WASM_SDK_URL
} from './probe-toolchain.mjs';

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

test('parses official Swift Wasm SDK fetch CLI arguments', () => {
	assert.deepEqual(parseFetchOfficialSdkArgs(['--help']), { help: true });
	assert.deepEqual(parseFetchOfficialSdkArgs([]), {
		outputPath: path.resolve(import.meta.dirname, '..', 'raw-runtime', 'sdk.tar.gz'),
		url: OFFICIAL_WASM_SDK_URL,
		checksum: OFFICIAL_WASM_SDK_CHECKSUM
	});
	assert.deepEqual(parseFetchOfficialSdkArgs(['--output', 'tmp/sdk.tar.gz']), {
		outputPath: path.resolve('tmp/sdk.tar.gz'),
		url: OFFICIAL_WASM_SDK_URL,
		checksum: OFFICIAL_WASM_SDK_CHECKSUM
	});
	assert.throws(() => parseFetchOfficialSdkArgs(['--output']), /--output requires a value/u);
	assert.throws(() => parseFetchOfficialSdkArgs(['--unknown']), /Unknown option: --unknown/u);
});

test('validates Swift.org SDK artifact URLs', () => {
	assert.equal(
		validateSwiftWasmSdkArtifactUrl('https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz'),
		true
	);
	assert.equal(validateSwiftWasmSdkArtifactUrl('http://download.swift.org/test/sdk.artifactbundle.tar.gz'), false);
	assert.equal(validateSwiftWasmSdkArtifactUrl('https://example.com/sdk.artifactbundle.tar.gz'), false);
	assert.equal(validateSwiftWasmSdkArtifactUrl('https://download.swift.org/test/sdk.artifactbundle.tar.gz'), false);
	assert.equal(validateSwiftWasmSdkArtifactUrl('https://download.swift.org/test/sdk.zip'), false);
});

test('downloads and checksum-verifies a Swift Wasm SDK artifact', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-sdk-fetch-'));
	try {
		const outputPath = path.join(dir, 'sdk.tar.gz');
		const bytes = Uint8Array.from(gzipSync(Uint8Array.of(115, 100, 107)));
		const checksum = sha256(bytes);
		const result = await fetchSwiftWasmSdkArtifact({
			outputPath,
			url: 'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
			checksum,
			fetchImpl: async () => ({
				ok: true,
				status: 200,
				arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
			})
		});

		assert.deepEqual(result, {
			bytes: bytes.byteLength,
			checksum,
			outputPath,
			url: 'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz'
		});
		assert.deepEqual(new Uint8Array(await readFile(outputPath)), bytes);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects failed or mismatched Swift Wasm SDK artifact downloads', async () => {
	await assert.rejects(
		() =>
			fetchSwiftWasmSdkArtifact({
				url: 'ftp://example.com/sdk.tar.gz',
				checksum: 'a'.repeat(64),
				fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })
			}),
		/Swift\.org Wasm SDK artifact bundle HTTPS URL/u
	);
	await assert.rejects(
		() =>
			fetchSwiftWasmSdkArtifact({
				url: 'https://example.com/sdk.artifactbundle.tar.gz',
				checksum: 'a'.repeat(64),
				fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })
			}),
		/Swift\.org Wasm SDK artifact bundle HTTPS URL/u
	);
	await assert.rejects(
		() =>
			fetchSwiftWasmSdkArtifact({
				url: 'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
				checksum: 'BAD',
				fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })
			}),
		/checksum must be a lowercase sha256 hex digest/u
	);
	await assert.rejects(
		() =>
			fetchSwiftWasmSdkArtifact({
				url: 'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
				checksum: 'a'.repeat(64),
				fetchImpl: async () => ({ ok: false, status: 404 })
			}),
		/HTTP 404/u
	);
	await assert.rejects(
		() =>
			fetchSwiftWasmSdkArtifact({
				url: 'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
				checksum: 'a'.repeat(64),
				fetchImpl: async () => ({
					ok: true,
					status: 200,
					arrayBuffer: async () => Uint8Array.of(1, 2, 3).buffer
				})
			}),
		/checksum mismatch/u
	);
	const invalidArchive = Uint8Array.of(31, 139, 8);
	await assert.rejects(
		() =>
			fetchSwiftWasmSdkArtifact({
				url: 'https://download.swift.org/test/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
				checksum: sha256(invalidArchive),
				fetchImpl: async () => ({
					ok: true,
					status: 200,
					arrayBuffer: async () =>
						invalidArchive.buffer.slice(
							invalidArchive.byteOffset,
							invalidArchive.byteOffset + invalidArchive.byteLength
						)
				})
			}),
		/Swift Wasm SDK artifact is invalid:[\s\S]*valid gzip archive/u
	);
});
