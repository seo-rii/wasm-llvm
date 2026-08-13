import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
	classifySwiftUpstreamRelease,
	createSwiftUpstreamDiscoveryNextActions,
	createSwiftUpstreamDiscoveryReceipt,
	discoverSwiftUpstreamAssets,
	parseDiscoverUpstreamArgs,
	writeSwiftUpstreamDiscoveryReceipt
} from './discover-upstream-assets.mjs';

test('parses Swift upstream discovery CLI arguments', () => {
	assert.deepEqual(parseDiscoverUpstreamArgs(['--help']), { help: true });
	assert.deepEqual(parseDiscoverUpstreamArgs([]), {
		apiUrl: 'https://api.github.com/repos/swiftwasm/swift/releases/latest',
		allowNoBrowserCompiler: false,
		json: false,
		receiptPath: null
	});
	assert.deepEqual(
		parseDiscoverUpstreamArgs([
			'--api-url',
			'https://example.com/release.json',
			'--allow-no-browser-compiler',
			'--json',
			'--receipt',
			'out/swift-upstream-discovery.json'
		]),
		{
			apiUrl: 'https://example.com/release.json',
			allowNoBrowserCompiler: true,
			json: true,
			receiptPath: 'out/swift-upstream-discovery.json'
		}
	);
	assert.throws(() => parseDiscoverUpstreamArgs(['--api-url']), /--api-url requires a value/u);
	assert.throws(
		() => parseDiscoverUpstreamArgs(['--api-url', 'file:///tmp/release.json']),
		/--api-url must be an HTTP\(S\) URL/u
	);
	assert.throws(() => parseDiscoverUpstreamArgs(['--receipt']), /--receipt requires a value/u);
	assert.throws(() => parseDiscoverUpstreamArgs(['--unknown']), /Unknown option: --unknown/u);
});

test('classifies SwiftWasm SDK artifacts separately from browser compiler candidates', () => {
	const result = classifySwiftUpstreamRelease({
		tag_name: 'swift-wasm-6.3-RELEASE',
		html_url: 'https://github.com/swiftwasm/swift/releases/tag/swift-wasm-6.3-RELEASE',
		assets: [
			{
				name: 'swift-wasm-6.3-RELEASE-wasm32-unknown-wasip1.artifactbundle.zip',
				size: 74_847_653,
				browser_download_url: 'https://example.com/sdk.zip'
			},
			{
				name: 'swift-6.3-RELEASE_macos.artifactbundle.zip',
				size: 10_000_000,
				browser_download_url: 'https://example.com/native-sdk.zip'
			},
			{
				name: 'swift-wasm-6.3-RELEASE-wasm32-unknown-wasip1.artifactbundle.zip.sha256',
				size: 64,
				browser_download_url: 'https://example.com/sdk.zip.sha256'
			}
		]
	});

	assert.equal(result.hasBrowserCompilerBundle, false);
	assert.deepEqual(
		result.sdkArtifacts.map((asset) => asset.name),
		['swift-wasm-6.3-RELEASE-wasm32-unknown-wasip1.artifactbundle.zip']
	);
	assert.deepEqual(
		result.sdkArtifacts.map((asset) => asset.checksumAsset?.name),
		['swift-wasm-6.3-RELEASE-wasm32-unknown-wasip1.artifactbundle.zip.sha256']
	);
	assert.deepEqual(
		result.sdkArtifacts.map((asset) => asset.archiveFormat),
		['zip']
	);
	assert.deepEqual(result.sdkArtifactsMissingChecksums, []);
	assert.deepEqual(
		result.sdkArtifactsNotGzip.map((asset) => asset.name),
		['swift-wasm-6.3-RELEASE-wasm32-unknown-wasip1.artifactbundle.zip']
	);
	assert.deepEqual(
		result.ignoredArtifactBundles.map((asset) => asset.name),
		['swift-6.3-RELEASE_macos.artifactbundle.zip']
	);
	assert.deepEqual(
		result.checksums.map((asset) => asset.name),
		['swift-wasm-6.3-RELEASE-wasm32-unknown-wasip1.artifactbundle.zip.sha256']
	);
	assert.deepEqual(result.browserCompilerCandidates, []);
	assert.deepEqual(createSwiftUpstreamDiscoveryNextActions(result), [
		'Build a browser-hosted Swift compiler bundle from source with bootstrap:wasm-swift-source and build:wasm-swift-browser-compiler.',
		'Use listed SwiftWasm SDK artifactbundles only as native Swift SDK inputs; they are not swiftc.wasm, swiftpm.wasm, or runner-worker.js browser runtime bundles.',
		'Do not pass upstream .artifactbundle.zip files directly as sdk.tar.gz; fetch or produce the gzip SDK archive expected by prepare:raw-runtime.'
	]);
});

test('reports SwiftWasm SDK artifacts without checksum sidecars', () => {
	const result = classifySwiftUpstreamRelease({
		tag_name: 'swift-wasm-6.3-RELEASE',
		assets: [
			{
				name: 'swift-wasm-6.3-RELEASE-wasm32-unknown-wasip1.artifactbundle.zip',
				size: 74_847_653
			}
		]
	});

	assert.deepEqual(
		result.sdkArtifactsMissingChecksums.map((asset) => asset.name),
		['swift-wasm-6.3-RELEASE-wasm32-unknown-wasip1.artifactbundle.zip']
	);
	assert.equal(result.sdkArtifacts[0].checksumAsset, null);
});

test('detects browser-hosted Swift compiler asset candidates when upstream provides them', () => {
	const result = classifySwiftUpstreamRelease({
		tagName: 'future-swift-browser-release',
		url: 'https://api.github.com/repos/swiftwasm/swift/releases/1',
		assets: [
			{ name: 'swiftc.wasm.gz', size: 123 },
			{ name: 'swiftpm.wasm', size: 456 },
			{ name: 'runner-worker.js', size: 789 },
			{ name: 'swift-browser-runtime-bundle.tar.gz', size: 1000 }
		]
	});

	assert.equal(result.hasBrowserCompilerBundle, true);
	assert.deepEqual(
		result.browserCompilerCandidates.map((asset) => asset.name),
		['swiftc.wasm.gz', 'swiftpm.wasm', 'runner-worker.js', 'swift-browser-runtime-bundle.tar.gz']
	);
});

test('creates a Swift upstream discovery receipt for sdk-only releases', () => {
	const result = classifySwiftUpstreamRelease({
		tag_name: 'swift-wasm-6.3-RELEASE',
		html_url: 'https://github.com/swiftwasm/swift/releases/tag/swift-wasm-6.3-RELEASE',
		assets: [
			{
				name: 'swift-wasm-6.3-RELEASE-wasm32-unknown-wasip1.artifactbundle.zip',
				size: 74_847_653,
				browser_download_url: 'https://example.com/sdk.zip'
			},
			{
				name: 'swift-wasm-6.3-RELEASE-wasm32-unknown-wasip1.artifactbundle.zip.sha256',
				size: 64,
				browser_download_url: 'https://example.com/sdk.zip.sha256'
			}
		]
	});

	const receipt = createSwiftUpstreamDiscoveryReceipt(result, {
		apiUrl: 'https://api.github.com/repos/swiftwasm/swift/releases/latest',
		discoveredAt: new Date('2026-01-01T00:00:00.000Z')
	});

	assert.deepEqual(receipt, {
		format: 'wasm-idle-swift-upstream-discovery-v1',
		discoveredAt: '2026-01-01T00:00:00.000Z',
		apiUrl: 'https://api.github.com/repos/swiftwasm/swift/releases/latest',
		repository: 'swiftwasm/swift',
		tagName: 'swift-wasm-6.3-RELEASE',
		htmlUrl: 'https://github.com/swiftwasm/swift/releases/tag/swift-wasm-6.3-RELEASE',
		assetCount: 2,
		hasBrowserCompilerBundle: false,
		status: 'sdk-only',
		sdkArtifacts: [
			{
				name: 'swift-wasm-6.3-RELEASE-wasm32-unknown-wasip1.artifactbundle.zip',
				size: 74_847_653,
				url: 'https://example.com/sdk.zip',
				archiveFormat: 'zip',
				checksumAsset: {
					name: 'swift-wasm-6.3-RELEASE-wasm32-unknown-wasip1.artifactbundle.zip.sha256',
					size: 64,
					url: 'https://example.com/sdk.zip.sha256'
				}
			}
		],
		sdkArtifactsMissingChecksums: [],
		sdkArtifactsNotGzip: [
			'swift-wasm-6.3-RELEASE-wasm32-unknown-wasip1.artifactbundle.zip'
		],
		ignoredArtifactBundles: [],
		checksums: [
			{
				name: 'swift-wasm-6.3-RELEASE-wasm32-unknown-wasip1.artifactbundle.zip.sha256',
				size: 64,
				url: 'https://example.com/sdk.zip.sha256'
			}
		],
		browserCompilerCandidates: [],
		nextActions: [
			'Build a browser-hosted Swift compiler bundle from source with bootstrap:wasm-swift-source and build:wasm-swift-browser-compiler.',
			'Use listed SwiftWasm SDK artifactbundles only as native Swift SDK inputs; they are not swiftc.wasm, swiftpm.wasm, or runner-worker.js browser runtime bundles.',
			'Do not pass upstream .artifactbundle.zip files directly as sdk.tar.gz; fetch or produce the gzip SDK archive expected by prepare:raw-runtime.'
		]
	});
});

test('writes a Swift upstream discovery receipt file', async () => {
	const tmpDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-discovery-'));
	try {
		const result = classifySwiftUpstreamRelease({
			tagName: 'future-swift-browser-release',
			assets: [{ name: 'swiftc.wasm.gz', size: 123, browser_download_url: 'https://example.com/swiftc.wasm.gz' }]
		});
		const receiptPath = path.join(tmpDir, 'nested', 'receipt.json');

		const written = await writeSwiftUpstreamDiscoveryReceipt(receiptPath, result, {
			apiUrl: 'https://example.com/release.json',
			discoveredAt: '2026-01-01T00:00:00.000Z'
		});

		assert.equal(written.receiptPath, receiptPath);
		const parsed = JSON.parse(await readFile(receiptPath, 'utf8'));
		assert.equal(parsed.status, 'browser-compiler-candidates-found');
		assert.deepEqual(parsed.browserCompilerCandidates, [
			{
				name: 'swiftc.wasm.gz',
				size: 123,
				url: 'https://example.com/swiftc.wasm.gz'
			}
		]);
	} finally {
		await rm(tmpDir, { recursive: true, force: true });
	}
});

test('discovers Swift upstream release assets through a fetch implementation', async () => {
	const result = await discoverSwiftUpstreamAssets({
		apiUrl: 'https://api.github.com/repos/swiftwasm/swift/releases/latest',
		fetchImpl: async (url, options) => {
			assert.equal(url, 'https://api.github.com/repos/swiftwasm/swift/releases/latest');
			assert.equal(options.headers.Accept, 'application/vnd.github+json');
			return {
				ok: true,
				status: 200,
				json: async () => ({
					tag_name: 'swift-wasm-6.3-RELEASE',
					assets: [{ name: 'swift-wasm-6.3-RELEASE-wasm32-unknown-wasip1.artifactbundle.zip' }]
				})
			};
		}
	});

	assert.equal(result.tagName, 'swift-wasm-6.3-RELEASE');
	assert.equal(result.hasBrowserCompilerBundle, false);
});

test('rejects invalid or failed Swift upstream discovery responses', async () => {
	assert.throws(() => classifySwiftUpstreamRelease(null), /release response must be an object/u);
	await assert.rejects(
		() =>
			discoverSwiftUpstreamAssets({
				apiUrl: 'ftp://example.com/release.json',
				fetchImpl: async () => ({ ok: true, json: async () => ({}) })
			}),
		/apiUrl must be an HTTP\(S\) URL/u
	);
	await assert.rejects(
		() =>
			discoverSwiftUpstreamAssets({
				fetchImpl: async () => ({ ok: false, status: 403 })
			}),
		/HTTP 403/u
	);
});
