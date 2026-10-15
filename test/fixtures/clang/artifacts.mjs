import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const name = Buffer.from('__asyncjs__waitForStdin');
const imports = Buffer.from([1, 3, ...Buffer.from('env'), name.length, ...name, 0, 0]);
export const clangdWasm = Buffer.concat([wasm, Buffer.from([1, 4, 1, 96, 0, 0, 2, imports.length]), imports]);
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
	const writeMetadata = () => fs.writeFile(path.join(directory, 'toolchain.json'), JSON.stringify(metadata));
	await writeMetadata();
	return { metadata, files, writeMetadata };
}
