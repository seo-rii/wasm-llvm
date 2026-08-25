import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	validateArtifactManifest as validateLldbArtifactManifest,
	validateBuildReceipt as validateLldbBuildReceipt
} from '../../lldb-browser/scripts/contracts.mjs';
import { verifyWamrBrowser } from '../../wamr-browser/scripts/verify.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LOCAL_ARTIFACT_DIR = path.resolve(REPO_ROOT, 'artifacts', 'clang-browser');
const SOURCE_DIR = resolveSourceDir();
const TARGET_DIR = path.resolve(
	process.env.WASM_LLVM_CLANG_RELEASE_DIR ||
		process.argv[2] ||
		path.join(REPO_ROOT, 'out', 'clang-browser')
);
const TARGET_BIN_DIR = path.resolve(TARGET_DIR, 'bin');
const TARGET_CLANGD_DIR = path.resolve(TARGET_DIR, 'clangd');
const LLDB_ARTIFACT_DIR = process.env.WASM_LLVM_LLDB_ARTIFACT_DIR
	? path.resolve(process.env.WASM_LLVM_LLDB_ARTIFACT_DIR)
	: null;
const WAMR_ARTIFACT_DIR = process.env.WASM_LLVM_WAMR_ARTIFACT_DIR
	? path.resolve(process.env.WASM_LLVM_WAMR_ARTIFACT_DIR)
	: null;
const assets = [
	{ source: 'clang.zip', target: ['bin', 'clang.zip'] },
	{ source: 'lld.zip', target: ['bin', 'lld.zip'] },
	{ source: 'memfs.zip', target: ['bin', 'memfs.zip'] },
	{ source: 'sysroot.tar.zip', target: ['bin', 'sysroot.tar.zip'] },
	{ source: 'clangd/clangd.js', target: ['clangd', 'clangd.js'] },
	{ source: 'clangd/clangd.wasm.gz', target: ['clangd', 'clangd.wasm.gz'] }
];

function resolveSourceDir() {
	if (process.env.WASM_LLVM_CLANG_ARTIFACT_DIR) {
		return path.resolve(process.env.WASM_LLVM_CLANG_ARTIFACT_DIR);
	}
	return LOCAL_ARTIFACT_DIR;
}

await fs.mkdir(TARGET_BIN_DIR, { recursive: true });
await fs.mkdir(TARGET_CLANGD_DIR, { recursive: true });

const toolchain = JSON.parse(await fs.readFile(path.resolve(SOURCE_DIR, 'toolchain.json'), 'utf8'));

const buildAssets = [];
for (const asset of assets) {
	const sourcePath = path.resolve(SOURCE_DIR, asset.source);
	const targetPath = path.resolve(TARGET_DIR, ...asset.target);
	const bytes = await fs.readFile(sourcePath);
	await fs.mkdir(path.dirname(targetPath), { recursive: true });
	await fs.writeFile(targetPath, bytes);
	buildAssets.push({
		asset: asset.source,
		size: bytes.byteLength,
		sha256: crypto.createHash('sha256').update(bytes).digest('hex')
	});
}

const manifest = {
	manifestVersion: 1,
	version: toolchain.version,
	defaultTarget: 'wasm32-wasi',
	compiler: {
		memfs: {
			asset: 'bin/memfs.zip',
			argv0: 'memfs'
		},
		clang: {
			asset: 'bin/clang.zip',
			argv0: 'clang'
		},
		lld: {
			asset: 'bin/lld.zip',
			argv0: 'wasm-ld'
		},
		sysroot: {
			asset: 'bin/sysroot.tar.zip'
		},
		...(toolchain.llvmCommit
			? {
					provenance: {
						name: 'clang',
						version: toolchain.llvmVersion,
						revision: toolchain.llvmCommit
					}
				}
			: {}),
		resourceDir: toolchain.resourceDir,
		compilerRuntimeLibDir: toolchain.compilerRuntimeLibDir
	},
	clangd: {
		js: 'clangd/clangd.js',
		wasm: 'clangd/clangd.wasm.gz'
	},
	targets: {
		'wasm32-wasi': {
			artifactFormat: 'wasi-core-wasm',
			execution: {
				kind: 'wasi-preview1'
			}
		}
	}
};

async function prepareDebugRuntimeManifest() {
	if (!LLDB_ARTIFACT_DIR && !WAMR_ARTIFACT_DIR) return null;
	if (!LLDB_ARTIFACT_DIR || !WAMR_ARTIFACT_DIR) {
		throw new Error(
			'Both WASM_LLVM_LLDB_ARTIFACT_DIR and WASM_LLVM_WAMR_ARTIFACT_DIR are required'
		);
	}
	if (!toolchain.llvmCommit) {
		throw new Error('The Clang toolchain must record llvmCommit for an LLDB runtime bundle');
	}

	const [lldbManifest, lldbReceipt, wamrReceipt] = await Promise.all([
		fs.readFile(path.join(LLDB_ARTIFACT_DIR, 'debug-manifest.json'), 'utf8').then(JSON.parse),
		fs
			.readFile(path.join(LLDB_ARTIFACT_DIR, 'lldb-browser.receipt.json'), 'utf8')
			.then(JSON.parse),
		fs.readFile(path.join(WAMR_ARTIFACT_DIR, 'producer-receipt.json'), 'utf8').then(JSON.parse)
	]);
	try {
		validateLldbArtifactManifest(lldbManifest);
		validateLldbBuildReceipt(lldbReceipt);
		if (
			typeof lldbManifest.version !== 'string' ||
			lldbManifest.version.length === 0 ||
			lldbManifest.debugger?.protocolVersion !== 1
		) {
			throw new Error('debug-manifest.json has an invalid version or protocol contract');
		}
		const requiredCapabilities = {
			breakpoints: true,
			stepping: true,
			stackTrace: true,
			locals: true,
			globals: true,
			readMemory: true,
			writeMemory: true,
			evaluateExpressions: false,
			dataBreakpoints: false,
			wasmThreads: false
		};
		for (const [capability, expected] of Object.entries(requiredCapabilities)) {
			if (lldbManifest.debugger?.capabilities?.[capability] !== expected) {
				throw new Error(`debug-manifest.json has an invalid ${capability} capability`);
			}
		}
	} catch (error) {
		throw new Error(
			`Invalid LLDB artifact manifest: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	const lldb = lldbManifest.debugger?.lldb;
	if (
		lldbReceipt.source?.patchesSha256 !== lldb?.patchesSha256 ||
		lldbReceipt.assets?.['lldb-web-dap.js']?.sha256 !== lldb?.jsSha256 ||
		lldbReceipt.assets?.['lldb-web-dap.wasm']?.sha256 !== lldb?.wasmSha256 ||
		lldbReceipt.assets?.[lldb?.worker]?.sha256 !== lldb?.workerSha256
	) {
		throw new Error('The LLDB manifest does not match its producer receipt');
	}
	if (
		lldbManifest.debugger?.transport?.contract !== 'shared-ring-v1' ||
		lldb?.llvmRevision !== toolchain.llvmCommit
	) {
		throw new Error(
			`Clang/LLDB revision mismatch: ${toolchain.llvmCommit} != ${lldb?.llvmRevision || 'unknown'}`
		);
	}

	const wamrSourceLock = JSON.parse(
		await fs.readFile(
			path.join(REPO_ROOT, 'producer', 'wamr-browser', 'sources.lock.json'),
			'utf8'
		)
	);
	if (
		wamrReceipt.format !== 'wasm-idle-wamr-debug-v1' ||
		wamrReceipt.protocolVersion !== 1 ||
		wamrReceipt.transport !== 'shared-ring-v1' ||
		wamrReceipt.pthreadTransport !== 'pthread-transport-v1'
	) {
		throw new Error('The WAMR artifact receipt has an incompatible protocol contract');
	}
	for (const provenance of [
		'sourcesLockSha256',
		'producerManifestSha256',
		'patchesSha256',
		'overlaysSha256'
	]) {
		if (
			typeof wamrReceipt.provenance?.[provenance] !== 'string' ||
			!/^[\da-f]{64}$/u.test(wamrReceipt.provenance[provenance])
		) {
			throw new Error(`The WAMR artifact receipt has invalid ${provenance} provenance`);
		}
	}
	if (
		wamrReceipt.wamrRevision !== wamrSourceLock.wamr?.commit ||
		wamrReceipt.emscriptenVersion !== wamrSourceLock.emscripten?.version ||
		wamrReceipt.emsdkRevision !== wamrSourceLock.emscripten?.commit
	) {
		throw new Error('The WAMR artifact receipt does not match the pinned source revisions');
	}
	if (!Array.isArray(wamrReceipt.assets)) {
		throw new Error('The WAMR artifact receipt has an invalid asset list');
	}
	const requiredWamrAssets = new Set([
		'wamr-debug.js',
		'wamr-debug.wasm',
		'wamr-debug.worker.mjs',
		'wamr-debug.wasm.gz'
	]);
	const seenWamrAssets = new Set();
	for (const asset of wamrReceipt.assets) {
		if (
			!asset ||
			typeof asset !== 'object' ||
			!requiredWamrAssets.has(asset.path) ||
			seenWamrAssets.has(asset.path) ||
			!Number.isSafeInteger(asset.bytes) ||
			asset.bytes <= 0 ||
			typeof asset.sha256 !== 'string' ||
			!/^[\da-f]{64}$/u.test(asset.sha256)
		) {
			throw new Error('The WAMR artifact receipt has an invalid or duplicate asset');
		}
		seenWamrAssets.add(asset.path);
	}
	if (
		seenWamrAssets.size !== requiredWamrAssets.size ||
		![...requiredWamrAssets].every((asset) => seenWamrAssets.has(asset))
	) {
		throw new Error('The WAMR artifact receipt is missing a required asset');
	}
	const wamrAssets = Object.fromEntries(wamrReceipt.assets.map((asset) => [asset.path, asset]));
	const wamrJs = wamrAssets['wamr-debug.js'];
	const wamrWasm = wamrAssets['wamr-debug.wasm'];
	const wamrWorker = wamrAssets['wamr-debug.worker.mjs'];
	const wamrCompressedWasm = wamrAssets['wamr-debug.wasm.gz'];
	if (
		!lldb?.worker ||
		!lldb?.workerSha256 ||
		!wamrJs?.sha256 ||
		!wamrWasm?.sha256 ||
		!wamrWorker?.sha256 ||
		wamrCompressedWasm?.uncompressedBytes !== wamrWasm.bytes ||
		wamrCompressedWasm?.uncompressedSha256 !== wamrWasm.sha256
	) {
		throw new Error(
			'The debugger receipts are missing required runtime asset or compression data'
		);
	}
	await verifyWamrBrowser({ artifacts: WAMR_ARTIFACT_DIR });

	const debugDir = path.join(TARGET_DIR, 'debug');
	await fs.mkdir(debugDir, { recursive: true });
	const debugAssets = [
		{
			source: path.join(LLDB_ARTIFACT_DIR, 'lldb-web-dap.js'),
			target: path.join(debugDir, 'lldb-web-dap.js'),
			sha256: lldb.jsSha256
		},
		{
			source: path.join(LLDB_ARTIFACT_DIR, 'lldb-web-dap.wasm'),
			target: path.join(debugDir, 'lldb-web-dap.wasm'),
			sha256: lldb.wasmSha256
		},
		{
			source: path.join(LLDB_ARTIFACT_DIR, lldb.worker),
			target: path.join(debugDir, lldb.worker),
			sha256: lldb.workerSha256
		},
		{
			source: path.join(WAMR_ARTIFACT_DIR, 'wamr-debug.js'),
			target: path.join(debugDir, 'wamr-debug.js'),
			sha256: wamrJs.sha256
		},
		{
			source: path.join(WAMR_ARTIFACT_DIR, 'wamr-debug.wasm'),
			target: path.join(debugDir, 'wamr-debug.wasm'),
			sha256: wamrWasm.sha256
		},
		{
			source: path.join(WAMR_ARTIFACT_DIR, 'wamr-debug.worker.mjs'),
			target: path.join(debugDir, 'wamr-debug.worker.mjs'),
			sha256: wamrWorker.sha256
		}
	];
	for (const asset of debugAssets) {
		const bytes = await fs.readFile(asset.source);
		const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
		if (actualSha256 !== asset.sha256) {
			throw new Error(`Debug runtime asset hash mismatch for ${path.basename(asset.source)}`);
		}
		await fs.copyFile(asset.source, asset.target);
	}

	const runtimeManifestV2 = {
		...manifest,
		manifestVersion: 2,
		debugger: {
			protocolVersion: 1,
			transport: 'shared-ring-v1',
			lldb: {
				js: 'debug/lldb-web-dap.js',
				wasm: 'debug/lldb-web-dap.wasm',
				worker: `debug/${lldb.worker}`,
				jsSha256: lldb.jsSha256,
				wasmSha256: lldb.wasmSha256,
				workerSha256: lldb.workerSha256,
				llvmVersion: lldb.llvmVersion,
				llvmRevision: lldb.llvmRevision,
				patchesSha256: lldb.patchesSha256,
				sourcesLockSha256: lldbReceipt.producer.sourcesLockSha256
			},
			targetRuntime: {
				name: 'wamr',
				js: 'debug/wamr-debug.js',
				wasm: 'debug/wamr-debug.wasm',
				worker: 'debug/wamr-debug.worker.mjs',
				jsSha256: wamrJs.sha256,
				wasmSha256: wamrWasm.sha256,
				workerSha256: wamrWorker.sha256,
				revision: wamrReceipt.wamrRevision,
				provenance: { ...wamrReceipt.provenance }
			},
			capabilities: {
				...lldbManifest.debugger.capabilities,
				evaluateExpressions: false,
				dataBreakpoints: false,
				wasmThreads: false
			}
		}
	};
	await fs.writeFile(
		path.resolve(TARGET_DIR, 'runtime-manifest.v2.json'),
		JSON.stringify(runtimeManifestV2, null, 2) + '\n'
	);
	return {
		lldb: lldbManifest,
		wamr: wamrReceipt
	};
}

const debugRuntime = await prepareDebugRuntimeManifest();

const buildInfo = {
	toolchain,
	assets: buildAssets,
	...(debugRuntime ? { debugRuntime } : {})
};

await fs.writeFile(
	path.resolve(TARGET_DIR, 'runtime-manifest.v1.json'),
	JSON.stringify(manifest, null, 2) + '\n'
);
await fs.writeFile(
	path.resolve(TARGET_DIR, 'runtime-build.json'),
	JSON.stringify(buildInfo, null, 2) + '\n'
);

console.log(`Prepared the Clang deployment bundle in ${TARGET_DIR}`);
