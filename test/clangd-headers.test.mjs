import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareClangdHeaders } from '../producer/clang-browser/scripts/prepare-clangd-headers.mjs';

async function fixture(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clangd-headers-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const sysroot = path.join(root, 'sysroot');
	const destination = path.join(root, 'clangd-include');
	const files = {
		'include/wasm32-wasip1/stdio.h': 'selected stdio',
		'include/wasm32-wasip1/noeh/c++/v1/__config_site': 'selected C++ configuration',
		'include/wasm32-wasip1/eh/c++/v1/__config_site': 'selected exception C++ configuration',
		'include/wasm32-wasip2/stdio.h': 'unrelated target',
		'include/wasm32-wasip1-threads/stdio.h': 'unrelated threaded target',
		'include/c++/v1/bits/stdc++.h': 'shared compatibility header',
		'share/libc++/v1/vector': 'shared C++ vector',
		'include/shared.h': 'shared C header'
	};
	for (const [relative, contents] of Object.entries(files)) {
		const file = path.join(sysroot, relative);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, contents);
	}
	await fs.symlink('wasm32-wasip1', path.join(sysroot, 'include/wasm32-wasi'));
	await fs.symlink('../../../share/libc++/v1/vector', path.join(sysroot, 'include/c++/v1/vector'));
	return { root, sysroot, destination, targetTriple: 'wasm32-wasi' };
}

async function snapshot(directory) {
	const result = {};
	async function walk(relative) {
		for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
			const next = path.join(relative, entry.name);
			const file = path.join(directory, next);
			if (entry.isSymbolicLink()) result[next] = { symlink: await fs.readlink(file) };
			else if (entry.isDirectory()) await walk(next);
			else result[next] = await fs.readFile(file, 'utf8');
		}
	}
	await walk('');
	return result;
}

test('retains shared and selected C/C++ headers, resolving aliases without modifying the sysroot', async (t) => {
	const options = await fixture(t);
	const before = await snapshot(options.sysroot);
	assert.equal(await prepareClangdHeaders(options), options.destination);
	assert.deepEqual(await snapshot(options.destination), {
		'c++/v1/bits/stdc++.h': 'shared compatibility header',
		'c++/v1/vector': 'shared C++ vector',
		'shared.h': 'shared C header',
		'wasm32-wasi/eh/c++/v1/__config_site': 'selected exception C++ configuration',
		'wasm32-wasi/noeh/c++/v1/__config_site': 'selected C++ configuration',
		'wasm32-wasi/stdio.h': 'selected stdio'
	});
	assert.deepEqual(await snapshot(options.sysroot), before);
});

test('reruns remove stale embedded headers and can select a concrete target', async (t) => {
	const options = await fixture(t);
	await prepareClangdHeaders(options);
	await fs.writeFile(path.join(options.destination, 'stale.h'), 'stale');
	await prepareClangdHeaders({ ...options, targetTriple: 'wasm32-wasip2' });
	assert.deepEqual(await fs.readdir(options.destination), ['c++', 'shared.h', 'wasm32-wasip2']);
	assert.equal(await fs.readFile(path.join(options.destination, 'wasm32-wasip2/stdio.h'), 'utf8'), 'unrelated target');
	assert.equal(await fs.readFile(path.join(options.sysroot, 'include/wasm32-wasi/stdio.h'), 'utf8'), 'selected stdio');
});

test('rejects invalid or unavailable targets before replacing the destination', async (t) => {
	const options = await fixture(t);
	await fs.mkdir(options.destination);
	await fs.writeFile(path.join(options.destination, 'keep.h'), 'previous output');
	for (const targetTriple of ['../wasm32-wasi', '/wasm32-wasi', '', 'x86_64-linux', 'wasm32-missing']) {
		await assert.rejects(prepareClangdHeaders({ ...options, targetTriple }), /Invalid clangd header target|target directory is missing/);
	}
	await fs.rm(path.join(options.sysroot, 'include/c++/v1/vector'));
	await assert.rejects(prepareClangdHeaders(options), /Required clangd header is missing/);
	assert.equal(await fs.readFile(path.join(options.destination, 'keep.h'), 'utf8'), 'previous output');
});

test('rejects destinations that overlap the sysroot or use symlink aliases', async (t) => {
	const options = await fixture(t);
	const before = await snapshot(options.sysroot);
	const alias = path.join(options.root, 'source-alias');
	await fs.symlink(options.sysroot, alias);
	for (const destination of [
		options.root,
		options.sysroot,
		path.join(options.sysroot, 'include'),
		path.join(options.sysroot, 'new', 'include'),
		alias,
		path.join(alias, 'new', 'include')
	]) {
		await assert.rejects(prepareClangdHeaders({ ...options, destination }), /separate from the source sysroot|not a symlink/);
	}
	const aliasParent = path.join(options.root, 'alias-parent');
	await fs.mkdir(aliasParent);
	await fs.symlink(options.sysroot, path.join(aliasParent, 'sysroot'));
	await assert.rejects(prepareClangdHeaders({
		...options,
		sysroot: path.join(aliasParent, 'sysroot'),
		destination: aliasParent
	}), /separate from the source sysroot/);
	assert.equal(await fs.readlink(path.join(aliasParent, 'sysroot')), options.sysroot);
	assert.deepEqual(await snapshot(options.sysroot), before);
});

test('rejects header aliases outside the sysroot and recursive directory aliases', async (t) => {
	const options = await fixture(t);
	await fs.writeFile(path.join(options.root, 'external.h'), 'external');
	const escape = path.join(options.sysroot, 'include/external.h');
	await fs.symlink('../../external.h', escape);
	await assert.rejects(prepareClangdHeaders(options), /symlink escapes the sysroot/);
	await fs.rm(escape);
	await fs.symlink('.', path.join(options.sysroot, 'include/c++/v1/cycle'));
	await assert.rejects(prepareClangdHeaders(options), /symlink creates a directory cycle/);
});
