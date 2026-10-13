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
	const toolchain = JSON.parse(await fs.readFile(path.join(artifacts, 'toolchain.json')));
	const derivation = toolchain.componentDerivation;
	assert.equal(derivation.compilerRebuilt, false);
	assert.equal(derivation.sysroot.headerSelection.policy, 'complete-selected-sdk-trees');
	assert.deepEqual(derivation.sysroot.headerSelection.trees, [
		{ path: 'include/wasm32-wasi', sourceFileCount: 206, outputFileCount: 206 },
		{ path: 'include/c++/v1', sourceFileCount: 1679, outputFileCount: 1684 },
		{ path: 'lib/clang/22/include', sourceFileCount: 267, outputFileCount: 267 }
	]);
	assert.equal(derivation.validation.completeSelectedHeaders, true);
	assert.equal(derivation.sysroot.retainedOriginalFileCount, derivation.sysroot.originalFileCount);
	assert.equal(derivation.source.sdkArchive.sha256,
		'0ba8b5bfaeb2adf3f29bab5841d76cf5318ab8e1642ea195f88baba1abd47bce');

	const zip = await fs.readFile(path.join(artifacts, 'sysroot.tar.zip'));
	assert.equal(sha(zip), toolchain.assets['sysroot.tar.zip']);
	assert.equal(sha(zip), derivation.sysroot.outputZipSha256);
	const reader = new ZipReader(new Uint8ArrayReader(zip), { useWebWorkers: false });
	let tar;
	try {
		const entries = (await reader.getEntries()).filter(entry => !entry.directory);
		assert.deepEqual(entries.map(entry => entry.filename), ['sysroot.tar']);
		tar = Buffer.from(await entries[0].getData(new Uint8ArrayWriter()));
	} finally { await reader.close(); }
	assert.deepEqual(digest(tar), derivation.sysroot.outputTar);
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'clang-complete-sysroot-'));
	t.after(() => fs.rm(temporary, { recursive: true, force: true }));
	const tarPath = path.join(temporary, 'sysroot.tar');
	const extracted = path.join(temporary, 'root');
	await fs.writeFile(tarPath, tar);
	await fs.mkdir(extracted);
	await execute('tar', ['-xf', tarPath, '-C', extracted]);
	const files = await inventory(extracted);
	assert.equal(files.size, derivation.sysroot.outputFileCount);
	for (const tree of derivation.sysroot.headerSelection.trees) {
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
	const addedPaths = new Set();
	for (const added of derivation.sysroot.addedFiles) {
		assert(!addedPaths.has(added.path), `Duplicate receipt entry: ${added.path}`);
		addedPaths.add(added.path);
		assert.deepEqual(digest(files.get(added.path)), { bytes: added.bytes, sha256: added.sha256 }, added.path);
		if (added.sourcePath === 'producer/clang-browser/scripts/gcc-compat.mjs') {
			assert.equal(added.sourceEntry, added.path);
			const header = GCC_COMPATIBILITY_HEADERS.find(header => header.path === added.path);
			assert(header, added.path);
			assert.deepEqual(files.get(added.path), Buffer.from(header.contents));
		} else assert(added.sourcePath.startsWith('wasi-sdk-33.0-x86_64-linux/'), added.sourcePath);
	}
	assert.equal(files.size, derivation.sysroot.originalFileCount + addedPaths.size);
	const recipe = await fs.readFile(path.join(artifacts, derivation.regeneration.helper.split('/').at(-1)));
	assert.deepEqual(digest(recipe), { bytes: derivation.regeneration.bytes, sha256: derivation.regeneration.sha256 });
	assert.equal(recipe.toString('utf8'), derivation.regeneration.helperSource);
	for (const [name, receipt] of Object.entries(derivation.source.scripts))
		assert.deepEqual(digest(await fs.readFile(path.join(repo, name))), receipt, name);
});

test('complete-header refresh preserves compiler, linker, language server and MemFS byte identities', async () => {
	const toolchain = JSON.parse(await fs.readFile(path.join(artifacts, 'toolchain.json')));
	for (const [name, expected] of Object.entries({
		'clang.zip': 'd088e163f4562c0befd12603468b8275ee18f9951e3e3dfa16b853de8e31c4ed',
		'lld.zip': 'b6f7a37892d92805912b1d42ece57d2b70207c59514c8cb6c57aa2fceaeb1039',
		'clangd/clangd.js': '92dce989f2623a6e8930369dd205301c2815d70cf81312c64de1c47a16302b27',
		'clangd/clangd.wasm.gz': '284e7117da923ca99ea9d64e4d9a80a739cdce4cc1c81dd099b040ab0a8a926f',
		'memfs.zip': 'a8091407232ff90aac632b625a2f932aad07cdbd7eab172638cb99983d4d08b2'
	})) {
		assert.equal(toolchain.assets[name], expected, name);
		assert.equal(sha(await fs.readFile(path.join(artifacts, name))), expected, name);
	}
	assert.equal(toolchain.memfs.files['memfs-build-receipt.json'].sha256,
		'c4ef4aa971195d15b4dec7abe617bce0292d2b889bfcc99ad67c2da1518c620b');
});
