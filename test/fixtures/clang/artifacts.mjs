import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const emptyWasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
// A minimal command with the same startup and memory ABI as default Clang/LLD.
// This is a structural fixture; it does not pretend to compile source code.
export const wasm = Buffer.concat([emptyWasm, Buffer.from([
	1, 4, 1, 0x60, 0, 0,
	3, 2, 1, 0,
	5, 3, 1, 0, 1,
	7, 19, 2, 6, ...Buffer.from('memory'), 2, 0, 6, ...Buffer.from('_start'), 0, 0,
	10, 4, 1, 2, 0, 0x0b
])]);
const name = Buffer.from('__asyncjs__waitForStdin');
const imports = Buffer.from([1, 3, ...Buffer.from('env'), name.length, ...name, 0, 0]);
export const clangdWasm = Buffer.concat([emptyWasm, Buffer.from([1, 4, 1, 96, 0, 0, 2, imports.length]), imports]);
export const clangdJs = Buffer.from('Module.stdinReady;');

export async function zipFiles(files) {
	const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
	for (const [name, bytes] of files)
		await writer.add(name, new Uint8ArrayReader(bytes), { lastModDate: new Date(0) });
	return Buffer.from(await writer.close());
}

export async function writeClangFixture(directory) {
	await fs.mkdir(path.join(directory, 'clangd'), { recursive: true });
	const manifestBytes = await fs.readFile(new URL('../../../producer/clang-browser/manifest.json', import.meta.url));
	const manifest = JSON.parse(manifestBytes);
	const files = new Map();
	for (const name of ['clang', 'lld', 'memfs', 'sysroot.tar'])
		files.set(`${name}.zip`, await zipFiles([[name, name === 'sysroot.tar' ? Buffer.alloc(1024) : wasm]]));
	files.set('clangd/clangd.js', clangdJs);
	files.set('clangd/clangd.wasm.gz', gzipSync(clangdWasm));
	const metadata = {
		producer: { id: manifest.producerId, manifest: 'producer/clang-browser/manifest.json', manifestSha256: sha256(manifestBytes) },
		version: 'fixture-a', llvmVersion: manifest.sources.llvm.version, llvmCommit: manifest.sources.llvm.commit,
		resourceDir: '/lib/clang/22', compilerRuntimeLibDir: 'lib/clang/22/lib/wasi',
		clangd: { stdinBridge: 'emscripten-asyncify' }, assets: {}
	};
	for (const [name, bytes] of files) {
		await fs.writeFile(path.join(directory, name), bytes);
		metadata.assets[name] = sha256(bytes);
	}
	await writeBuildReceipt(directory, metadata, { clang: wasm, lld: wasm, sysroot: Buffer.alloc(1024), clangdJs, clangdWasm });
	const writeMetadata = () => fs.writeFile(path.join(directory, 'toolchain.json'), JSON.stringify(metadata));
	await writeMetadata();
	return { metadata, files, writeMetadata };
}

// Synthetic evidence for tiny structural fixtures; never used to qualify production bytes.
export async function makeBuildReceipt(inputs) {
	const { fileIdentity } = await import('../../../producer/clang-browser/scripts/build-provenance.mjs');
	const producerRoot = new URL('../../../producer/clang-browser/', import.meta.url);
	const manifestBytes = await fs.readFile(new URL('manifest.json', producerRoot));
	const manifest = JSON.parse(manifestBytes);
	const identity = (bytes) => ({ bytes: bytes.length, sha256: sha256(bytes) });
	const files = [];
	for (const file of ['build-toolchain.mjs', 'build-provenance.mjs', 'build-memfs.mjs',
		'prepare-clangd-headers.mjs', 'sysroot-pruning.mjs', 'gcc-compat.mjs', 'hot-path-launcher.sh',
		'resource-profile.mjs']) {
		files.push({ path: `scripts/${file}`, ...await fileIdentity(new URL(`scripts/${file}`, producerRoot)) });
	}
	const source = { tree: 'b'.repeat(40), diffSha256: sha256('synthetic fixture diff') };
	return {
		schemaVersion: 1, producerId: manifest.producerId, kind: 'clang-build-receipt', manifestSha256: sha256(manifestBytes),
		sources: {
			llvm: { ...source, repository: manifest.sources.llvm.repository, commit: manifest.sources.llvm.commit,
				patches: [{ ...manifest.sources.wasiHostPatch, sha256: sha256('synthetic fixture patch') }, manifest.sources.llvmWasiClosePatch,
					manifest.sources.lldWasmOnlyPatch, manifest.sources.clangdEmscriptenStdinPatch,
					manifest.sources.wasmFunctionEndPatch] },
			emsdk: { ...source, repository: 'https://github.com/emscripten-core/emsdk', commit: manifest.toolchains.emsdk.commit }
		},
		buildMode: 'fresh-output-directory',
		installedToolchains: { wasiSdk: { bytes: 1, entries: 1, sha256: sha256('SDK fixture') },
			emsdkUpstream: { bytes: 1, entries: 1, sha256: sha256('Emscripten fixture') } },
		buildOptions: { clangdSeparateHeaders: inputs.clangdHeaders ? 'ON' : 'OFF', llvmCommit: manifest.sources.llvm.commit, emsdkCommit: manifest.toolchains.emsdk.commit,
			llvmVersion: manifest.sources.llvm.version, emsdkVersion: manifest.toolchains.emsdk.version,
			wasiSdkVersion: manifest.toolchains.wasiSdk.version, yowaspWasiPatchRepo: manifest.sources.wasiHostPatch.repository,
			yowaspWasiPatchCommit: manifest.sources.wasiHostPatch.commit },
		inputs: Object.fromEntries(Object.entries(inputs).map(([name, bytes]) => [name, identity(bytes)])),
		recipe: { files, sha256: sha256(JSON.stringify(files)) },
		tools: Object.fromEntries(['cmake', 'ninja', 'tar', 'wasiClang', 'wasiClangxx', 'wasiAr', 'wasiRanlib', 'wasiLld', 'nativeC', 'nativeCxx',
			'llvmTablegen', 'clangTablegen', 'emsdkClang', 'wasmOpt', 'emccDriver'].map((name) => [name, identity(Buffer.from(name))])),
		reproducibility: { independentlyRebuilt: false }
	};
}

export async function writeBuildReceipt(directory, metadata, inputs) {
	const memfs = inputs.memfs || wasm;
	const manifest = JSON.parse(await fs.readFile(new URL('../../../producer/clang-browser/manifest.json', import.meta.url)));
	const source = manifest.sources.memfs;
	const memfsReceipt = {
		format: 'wasm-llvm-memfs-build-v1', maxNodes: source.maxNodes,
		abi: { maxNodes: source.maxNodes, usableNodes: source.maxNodes - 4 },
		source: { repository: source.repository, commit: source.commit, files: source.files },
		patch: { originalSha256: source.files['memfs.c'].sha256, patchedSha256: 'a'.repeat(64), builderSha256: 'b'.repeat(64) },
		license: source.license, outputs: { 'memfs.wasm': { bytes: memfs.length, sha256: sha256(memfs) } }
	};
	const memfsReceiptBytes = Buffer.from(`${JSON.stringify(memfsReceipt)}\n`);
	const memfsFiles = new Map([['memfs-build-receipt.json', memfsReceiptBytes]]);
	for (const [sourceName, targetName] of [['LICENSE.llvm.txt', 'LICENSE.memfs-llvm.txt'], ['LICENSE.stb_sprintf.txt', 'LICENSE.memfs-stb_sprintf.txt']]) {
		const bytes = await fs.readFile(new URL(`../memfs/${sourceName}`, import.meta.url));
		memfsFiles.set(targetName, bytes);
		await fs.writeFile(path.join(directory, sourceName), bytes);
	}
	for (const [name, bytes] of memfsFiles) await fs.writeFile(path.join(directory, name), bytes);
	metadata.memfs = { buildReceipt: memfsReceipt,
		files: Object.fromEntries([...memfsFiles].map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha256(bytes) }])) };
	const receipt = await makeBuildReceipt({ ...inputs, memfs, memfsReceipt: memfsReceiptBytes });
	const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
	await fs.writeFile(path.join(directory, 'clang-build-receipt.json'), bytes);
	metadata.buildProvenance = { status: 'verified', receipt: 'clang-build-receipt.json', bytes: bytes.length, sha256: sha256(bytes) };
	for (const name of ['llvmVersion', 'llvmCommit', 'wasiSdkVersion', 'emsdkVersion']) metadata[name] = receipt.buildOptions[name];
	return receipt;
}
