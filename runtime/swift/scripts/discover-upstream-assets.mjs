#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const DEFAULT_REPOSITORY = 'swiftwasm/swift';
export const DEFAULT_API_URL = `https://api.github.com/repos/${DEFAULT_REPOSITORY}/releases/latest`;
const BROWSER_COMPILER_ASSET_PATTERNS = [
	/\bswiftc(?:[._-].*)?\.wasm(?:\.gz)?$/iu,
	/\bswiftpm(?:[._-].*)?\.wasm(?:\.gz)?$/iu,
	/\brunner-worker\.js$/iu,
	/\bbrowser(?:[._-]swift)?(?:[._-]compiler|[._-]runtime)?(?:[._-]bundle)?\.(?:tar\.gz|zip)$/iu
];
const ARTIFACT_BUNDLE_PATTERN = /\.artifactbundle\.(?:zip|tar\.gz)$/iu;
const WASM_SDK_ARTIFACT_PATTERN =
	/(?:_wasm|wasm32|wasip\d*|wasi(?:32|64)?).*\.artifactbundle\.(?:zip|tar\.gz)$/iu;

function artifactBundleArchiveFormat(name) {
	if (/\.artifactbundle\.tar\.gz$/iu.test(name)) return 'tar.gz';
	if (/\.artifactbundle\.zip$/iu.test(name)) return 'zip';
	return null;
}

function readOptionValue(argv, index, optionName) {
	const value = argv[index + 1];
	if (typeof value !== 'string' || !value || value.startsWith('--')) {
		throw new Error(`${optionName} requires a value`);
	}
	return value;
}

function assertHttpUrl(value, optionName) {
	if (typeof value !== 'string' || !/^https?:\/\//u.test(value)) {
		throw new Error(`${optionName} must be an HTTP(S) URL`);
	}
}

export function parseDiscoverUpstreamArgs(argv) {
	const options = {
		apiUrl: DEFAULT_API_URL,
		allowNoBrowserCompiler: false,
		json: false,
		receiptPath: null
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--') {
			continue;
		} else if (arg === '--help') {
			return { help: true };
		} else if (arg === '--api-url') {
			options.apiUrl = readOptionValue(argv, index, arg);
			assertHttpUrl(options.apiUrl, arg);
			index += 1;
		} else if (arg === '--allow-no-browser-compiler') {
			options.allowNoBrowserCompiler = true;
		} else if (arg === '--json') {
			options.json = true;
		} else if (arg === '--receipt') {
			options.receiptPath = readOptionValue(argv, index, arg);
			index += 1;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

export function classifySwiftUpstreamRelease(release) {
	if (!release || typeof release !== 'object' || Array.isArray(release)) {
		throw new Error('GitHub release response must be an object');
	}
	const assets = Array.isArray(release.assets) ? release.assets : [];
	const normalizedAssets = assets
		.filter((asset) => asset && typeof asset === 'object' && typeof asset.name === 'string')
		.map((asset) => ({
			name: asset.name,
			size: Number.isSafeInteger(asset.size) ? asset.size : null,
			url: typeof asset.browser_download_url === 'string'
				? asset.browser_download_url
				: typeof asset.url === 'string'
					? asset.url
					: null
		}));
	const artifactBundles = normalizedAssets.filter((asset) =>
		ARTIFACT_BUNDLE_PATTERN.test(asset.name)
	);
	const sdkArtifacts = artifactBundles.filter((asset) =>
		WASM_SDK_ARTIFACT_PATTERN.test(asset.name)
	);
	const ignoredArtifactBundles = artifactBundles.filter(
		(asset) => !WASM_SDK_ARTIFACT_PATTERN.test(asset.name)
	);
	const checksums = normalizedAssets.filter((asset) => /\.sha256$/iu.test(asset.name));
	const checksumByName = new Map(checksums.map((asset) => [asset.name, asset]));
	const sdkArtifactsWithChecksums = sdkArtifacts.map((asset) => ({
		...asset,
		archiveFormat: artifactBundleArchiveFormat(asset.name),
		checksumAsset: checksumByName.get(`${asset.name}.sha256`) ?? null
	}));
	const sdkArtifactsMissingChecksums = sdkArtifactsWithChecksums.filter(
		(asset) => !asset.checksumAsset
	);
	const sdkArtifactsNotGzip = sdkArtifactsWithChecksums.filter(
		(asset) => asset.archiveFormat !== 'tar.gz'
	);
	const browserCompilerCandidates = normalizedAssets.filter((asset) =>
		BROWSER_COMPILER_ASSET_PATTERNS.some((pattern) => pattern.test(asset.name))
	);
	return {
		repository: DEFAULT_REPOSITORY,
		tagName: typeof release.tag_name === 'string'
			? release.tag_name
			: typeof release.tagName === 'string'
				? release.tagName
				: null,
		htmlUrl: typeof release.html_url === 'string'
			? release.html_url
			: typeof release.url === 'string'
				? release.url
				: null,
		assetCount: normalizedAssets.length,
		sdkArtifacts: sdkArtifactsWithChecksums,
		sdkArtifactsMissingChecksums,
		sdkArtifactsNotGzip,
		ignoredArtifactBundles,
		checksums,
		browserCompilerCandidates,
		hasBrowserCompilerBundle: browserCompilerCandidates.length > 0
	};
}

export function createSwiftUpstreamDiscoveryNextActions(result) {
	if (result.hasBrowserCompilerBundle) {
		return [
			'Import the browser compiler bundle through import:wasm-swift or import-sync:wasm-swift:strict, then run verify:wasm-swift-candidate before registration.'
		];
	}
	const actions = [
		'Build a browser-hosted Swift compiler bundle from source with bootstrap:wasm-swift-source and build:wasm-swift-browser-compiler.'
	];
	if (result.sdkArtifacts.length > 0) {
		actions.push(
			'Use listed SwiftWasm SDK artifactbundles only as native Swift SDK inputs; they are not swiftc.wasm, swiftpm.wasm, or runner-worker.js browser runtime bundles.'
		);
	}
	if (result.sdkArtifactsNotGzip.length > 0) {
		actions.push(
			'Do not pass upstream .artifactbundle.zip files directly as sdk.tar.gz; fetch or produce the gzip SDK archive expected by prepare:raw-runtime.'
		);
	}
	return actions;
}

export async function discoverSwiftUpstreamAssets({
	apiUrl = DEFAULT_API_URL,
	fetchImpl = globalThis.fetch
} = {}) {
	if (typeof fetchImpl !== 'function') throw new Error('fetch is not available in this Node.js runtime');
	assertHttpUrl(apiUrl, 'apiUrl');
	const response = await fetchImpl(apiUrl, {
		headers: {
			Accept: 'application/vnd.github+json',
			'User-Agent': 'wasm-idle-swift-upstream-discovery'
		}
	});
	if (!response?.ok) {
		throw new Error(`Swift upstream release discovery failed: HTTP ${response?.status ?? 'unknown'}`);
	}
	return classifySwiftUpstreamRelease(await response.json());
}

export function createSwiftUpstreamDiscoveryReceipt(result, { apiUrl, discoveredAt = new Date() } = {}) {
	return {
		format: 'wasm-idle-swift-upstream-discovery-v1',
		discoveredAt: discoveredAt instanceof Date ? discoveredAt.toISOString() : String(discoveredAt),
		apiUrl,
		repository: result.repository,
		tagName: result.tagName,
		htmlUrl: result.htmlUrl,
		assetCount: result.assetCount,
		hasBrowserCompilerBundle: result.hasBrowserCompilerBundle,
		status: result.hasBrowserCompilerBundle ? 'browser-compiler-candidates-found' : 'sdk-only',
		sdkArtifacts: result.sdkArtifacts.map((asset) => ({
			name: asset.name,
			size: asset.size,
			url: asset.url,
			archiveFormat: asset.archiveFormat,
			checksumAsset: asset.checksumAsset
				? {
						name: asset.checksumAsset.name,
						size: asset.checksumAsset.size,
						url: asset.checksumAsset.url
					}
				: null
		})),
		sdkArtifactsMissingChecksums: result.sdkArtifactsMissingChecksums.map((asset) => asset.name),
		sdkArtifactsNotGzip: result.sdkArtifactsNotGzip.map((asset) => asset.name),
		ignoredArtifactBundles: result.ignoredArtifactBundles.map((asset) => asset.name),
		checksums: result.checksums.map((asset) => ({
			name: asset.name,
			size: asset.size,
			url: asset.url
		})),
		browserCompilerCandidates: result.browserCompilerCandidates.map((asset) => ({
			name: asset.name,
			size: asset.size,
			url: asset.url
		})),
		nextActions: createSwiftUpstreamDiscoveryNextActions(result)
	};
}

export async function writeSwiftUpstreamDiscoveryReceipt(receiptPath, result, options) {
	if (typeof receiptPath !== 'string' || receiptPath.trim().length === 0) {
		throw new Error('receiptPath must be a non-empty path');
	}
	const normalizedReceiptPath = path.resolve(receiptPath);
	const receipt = createSwiftUpstreamDiscoveryReceipt(result, options);
	await mkdir(path.dirname(normalizedReceiptPath), { recursive: true });
	await writeFile(normalizedReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
	return { receiptPath: normalizedReceiptPath, receipt };
}

function usage() {
	return [
		'Usage: pnpm --dir runtime/swift run discover:upstream -- [--json] [--receipt path] [--allow-no-browser-compiler]',
		'',
		'Checks the latest swiftwasm/swift release assets for redistributable browser compiler',
		'candidates such as swiftc.wasm, swiftpm.wasm, runner-worker.js, or a browser runtime bundle.',
		'SDK artifactbundle archives are reported separately because they are native Swift SDK inputs,',
		'not browser-hosted compiler runtimes.'
	].join('\n');
}

function formatDiscovery(result) {
	return [
		`Repository: ${result.repository}`,
		`Release: ${result.tagName ?? 'unknown'}`,
		`Assets: ${result.assetCount}`,
		`SDK artifact bundles: ${result.sdkArtifacts.map((asset) => asset.name).join(', ') || 'none'}`,
		`SDK artifact bundles missing checksums: ${
			result.sdkArtifactsMissingChecksums.map((asset) => asset.name).join(', ') || 'none'
		}`,
		`SDK artifact bundles not usable as sdk.tar.gz: ${
			result.sdkArtifactsNotGzip.map((asset) => asset.name).join(', ') || 'none'
		}`,
		`Ignored non-Wasm artifact bundles: ${
			result.ignoredArtifactBundles.map((asset) => asset.name).join(', ') || 'none'
		}`,
		`Checksums: ${result.checksums.map((asset) => asset.name).join(', ') || 'none'}`,
		`Browser compiler candidates: ${
			result.browserCompilerCandidates.map((asset) => asset.name).join(', ') || 'none'
		}`,
		'Next actions:',
		...createSwiftUpstreamDiscoveryNextActions(result).map((action) => `  - ${action}`)
	].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		const options = parseDiscoverUpstreamArgs(process.argv.slice(2));
		if (options.help) {
			console.log(usage());
		} else {
			const result = await discoverSwiftUpstreamAssets(options);
			if (options.receiptPath) {
				const { receiptPath } = await writeSwiftUpstreamDiscoveryReceipt(options.receiptPath, result, {
					apiUrl: options.apiUrl
				});
				console.error(`Wrote Swift upstream discovery receipt: ${receiptPath}`);
			}
			if (options.json) {
				console.log(JSON.stringify(result, null, 2));
			} else {
				console.log(formatDiscovery(result));
			}
			if (!result.hasBrowserCompilerBundle && !options.allowNoBrowserCompiler) {
				throw new Error(
					'No browser-hosted Swift compiler bundle candidate was found in upstream release assets.'
				);
			}
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
