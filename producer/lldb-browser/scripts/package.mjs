#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import {
	LLVM_VERSION,
	PRODUCER_ROOT,
	REPO_ROOT,
	assertBrowserTransportArtifact,
	createArtifactManifest,
	createBuildReceipt,
	getLockedPthreadWorkerSha256,
	loadProducerMetadata,
	sha256,
	validateArtifactManifest,
	validateBuildReceipt,
	verifyLockedInputs
} from './contracts.mjs';
import { EMSCRIPTEN_LINK_FLAGS } from './build.mjs';

const defaultTargetDir = path.resolve(
	process.env.WASM_LLVM_LLDB_OUT_DIR || path.join(REPO_ROOT, 'artifacts', 'lldb-browser')
);

export function parsePackageArgs(argv) {
	const options = {
		targetDir: defaultTargetDir,
		version: `llvmorg-${LLVM_VERSION}-lldb-web-3`
	};
	for (let index = 0; index < argv.length; ++index) {
		const argument = argv[index];
		if (argument === '--') continue;
		if (argument === '--help' || argument === '-h') {
			options.help = true;
			continue;
		}
		if (
			argument === '--js' ||
			argument === '--wasm' ||
			argument === '--worker' ||
			argument === '--target-dir' ||
			argument === '--version'
		) {
			const value = argv[++index];
			if (!value) throw new Error(`Missing value for ${argument}`);
			if (argument === '--js') options.jsPath = path.resolve(value);
			if (argument === '--wasm') options.wasmPath = path.resolve(value);
			if (argument === '--worker') options.workerPath = path.resolve(value);
			if (argument === '--target-dir') options.targetDir = path.resolve(value);
			if (argument === '--version') options.version = value;
			continue;
		}
		throw new Error(`Unknown option: ${argument}`);
	}
	return options;
}

async function writeAtomic(filePath, bytes) {
	const temporaryPath = `${filePath}.tmp-${process.pid}`;
	await fs.writeFile(temporaryPath, bytes);
	await fs.rename(temporaryPath, filePath);
}

export async function packageArtifacts(options) {
	if (!options.jsPath) throw new Error('Missing required option --js');
	if (!options.wasmPath) throw new Error('Missing required option --wasm');
	if (!options.workerPath) throw new Error('Missing required option --worker');

	const { manifest, sourcesLock } = await loadProducerMetadata();
	await verifyLockedInputs(sourcesLock);
	const [jsBytes, wasmBytes, workerBytes, producerManifestBytes, sourcesLockBytes] =
		await Promise.all([
			fs.readFile(options.jsPath),
			fs.readFile(options.wasmPath),
			fs.readFile(options.workerPath),
			fs.readFile(path.join(PRODUCER_ROOT, 'manifest.json')),
			fs.readFile(path.join(PRODUCER_ROOT, 'sources.lock.json'))
		]);
	if (jsBytes.byteLength === 0 || wasmBytes.byteLength === 0 || workerBytes.byteLength === 0) {
		throw new Error('LLDB browser artifacts must not be empty');
	}
	if (sha256(workerBytes) !== getLockedPthreadWorkerSha256(sourcesLock)) {
		throw new Error('pthread worker output differs from its locked overlay');
	}
	await assertBrowserTransportArtifact(jsBytes, wasmBytes, workerBytes);

	const receipt = createBuildReceipt({
		version: options.version,
		manifestSha256: sha256(producerManifestBytes),
		sourcesLockSha256: sha256(sourcesLockBytes),
		jsBytes,
		wasmBytes,
		workerBytes,
		patchesSha256: sha256(sourcesLock.patches.map((entry) => entry.sha256).join('\n')),
		buildFlags: EMSCRIPTEN_LINK_FLAGS
	});
	const artifactManifest = createArtifactManifest({
		version: options.version,
		jsSha256: receipt.assets['lldb-web-dap.js'].sha256,
		wasmSha256: receipt.assets['lldb-web-dap.wasm'].sha256,
		workerSha256: receipt.assets['lldb-web-dap.pthread.mjs'].sha256,
		patchesSha256: receipt.source.patchesSha256,
		capabilities: manifest.capabilities
	});
	validateBuildReceipt(receipt);
	validateArtifactManifest(artifactManifest);

	await fs.mkdir(options.targetDir, { recursive: true });
	await Promise.all([
		writeAtomic(path.join(options.targetDir, 'lldb-web-dap.js'), jsBytes),
		writeAtomic(path.join(options.targetDir, 'lldb-web-dap.wasm'), wasmBytes),
		writeAtomic(path.join(options.targetDir, 'lldb-web-dap.pthread.mjs'), workerBytes),
		writeAtomic(
			path.join(options.targetDir, 'lldb-browser.receipt.json'),
			JSON.stringify(receipt, null, 2) + '\n'
		),
		writeAtomic(
			path.join(options.targetDir, 'debug-manifest.json'),
			JSON.stringify(artifactManifest, null, 2) + '\n'
		)
	]);
	return { receipt, artifactManifest };
}

async function main() {
	const options = parsePackageArgs(process.argv.slice(2));
	if (options.help) {
		console.log(`Usage: node producer/lldb-browser/scripts/package.mjs \\
  --js /path/to/lldb-web-dap.js \\
  --wasm /path/to/lldb-web-dap.wasm \\
  --worker /path/to/lldb-web-dap.pthread.mjs [options]

Options:
  --target-dir DIR   Output directory (defaults to artifacts/lldb-browser).
  --version VERSION  Runtime artifact version.`);
		return;
	}
	await packageArtifacts(options);
	console.log(`Packaged LLDB browser artifacts in ${options.targetDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
