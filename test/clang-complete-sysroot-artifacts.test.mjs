import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';
import { GCC_COMPATIBILITY_HEADERS } from '../producer/clang-browser/scripts/gcc-compat.mjs';
import { loadVerifiedClangArtifacts } from '../producer/clang-browser/scripts/verify-artifacts.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(repo, 'artifacts/clang-browser');
const execute = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = bytes => ({ bytes: bytes.length, sha256: sha(bytes) });

async function inventory(root) {
	const files = new Map();
	async function walk(relative = '') {
		for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
			const name = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await walk(name);
			else {
				assert(entry.isFile(), `Non-regular archive entry: ${name}`);
				files.set(name, await fs.readFile(path.join(root, name)));
			}
		}
	}
	await walk();
	return files;
}

test('shipped sysroot retains complete selected SDK header trees and receipt-bound source files', async t => {
	const { metadata: toolchain, sidecars } = await loadVerifiedClangArtifacts(artifacts, { requireBuildReceipt: true });
	const receipt = JSON.parse(sidecars.get('clang-build-receipt.json'));
	assert.equal(toolchain.componentDerivation, undefined);
	assert.equal(receipt.buildMode, 'fresh-output-directory');
	assert.equal(receipt.sources.llvm.commit, 'ca7933e47d3a3451d81e72ac174dcb5aa28b59d1');
	assert.equal(receipt.buildOptions.wasiSdkVersion, '33');
	// The clean producer includes the complete selected header trees, including
	// the additional C/resource headers omitted by the older component refresh.
	const headerTrees = [
		{ path: 'include/wasm32-wasi', outputFileCount: 213 },
		{ path: 'include/c++/v1', outputFileCount: 1684 },
		{ path: 'lib/clang/22/include', outputFileCount: 275 }
	];

	const zip = await fs.readFile(path.join(artifacts, 'sysroot.tar.zip'));
	assert.equal(sha(zip), toolchain.assets['sysroot.tar.zip']);
	const reader = new ZipReader(new Uint8ArrayReader(zip), { useWebWorkers: false });
	let tar;
	try {
		const entries = (await reader.getEntries()).filter(entry => !entry.directory);
		assert.deepEqual(entries.map(entry => entry.filename), ['sysroot.tar']);
		tar = Buffer.from(await entries[0].getData(new Uint8ArrayWriter()));
	} finally { await reader.close(); }
	assert.deepEqual(digest(tar), receipt.inputs.sysroot);
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'clang-complete-sysroot-'));
	t.after(() => fs.rm(temporary, { recursive: true, force: true }));
	const tarPath = path.join(temporary, 'sysroot.tar');
	const extracted = path.join(temporary, 'root');
	await fs.writeFile(tarPath, tar);
	await fs.mkdir(extracted);
	await execute('tar', ['-xf', tarPath, '-C', extracted]);
	const files = await inventory(extracted);
	assert.equal(files.size, 2183);
	for (const tree of headerTrees) {
		assert.equal([...files.keys()].filter(name => name.startsWith(`${tree.path}/`)).length,
			tree.outputFileCount, tree.path);
	}
	for (const header of [
		'any', 'barrier', 'bit', 'cfenv', 'charconv', 'chrono', 'complex', 'condition_variable',
		'coroutine', 'expected', 'filesystem', 'flat_map', 'flat_set', 'forward_list', 'fstream',
		'future', 'inttypes.h', 'latch', 'mdspan', 'memory_resource', 'numbers', 'random', 'ranges',
		'regex', 'semaphore', 'shared_mutex', 'source_location', 'span', 'stop_token', 'syncstream',
		'thread', 'typeindex', 'valarray', '__bit/byteswap.h', 'experimental/iterator', 'module.modulemap'
	]) assert(files.has(`include/c++/v1/${header}`), `Missing libc++ header: ${header}`);
	for (const header of ['inttypes.h', 'fenv.h', 'setjmp.h', 'signal.h', 'uchar.h'])
		assert(files.has(`include/wasm32-wasi/${header}`), `Missing WASI C header: ${header}`);
	for (const header of GCC_COMPATIBILITY_HEADERS) {
		assert.deepEqual(files.get(header.path), Buffer.from(header.contents), header.path);
	}
	for (const entry of receipt.recipe.files) {
		assert.deepEqual(digest(await fs.readFile(path.join(repo, 'producer/clang-browser', entry.path))),
			{ bytes: entry.bytes, sha256: entry.sha256 }, entry.path);
	}
});

test('shipped compiler, linker, language server and MemFS match the qualified source build', async () => {
	const toolchain = JSON.parse(await fs.readFile(path.join(artifacts, 'toolchain.json')));
	for (const [name, expected] of Object.entries({
		'clang.zip': '32a750f8966d0bd356e1b39bc91d3b2722166fcc1f31f7c842d6db34f99f609e',
		'lld.zip': 'f8729099758f12ac62f27d9df4af24d2fdd7887d78c0a92a241c9bd765445eb8',
		'clangd/clangd.js': '92dce989f2623a6e8930369dd205301c2815d70cf81312c64de1c47a16302b27',
		'clangd/clangd.wasm.gz': '284e7117da923ca99ea9d64e4d9a80a739cdce4cc1c81dd099b040ab0a8a926f',
		'memfs.zip': '57b8cb610d22a8229cfb71fa67c1ba1bd8a552b8c32375d105e2ef1ca4a78a05'
	})) {
		assert.equal(toolchain.assets[name], expected, name);
		assert.equal(sha(await fs.readFile(path.join(artifacts, name))), expected, name);
	}
	assert.equal(toolchain.memfs.files['memfs-build-receipt.json'].sha256,
		'c4ef4aa971195d15b4dec7abe617bce0292d2b889bfcc99ad67c2da1518c620b');
});
