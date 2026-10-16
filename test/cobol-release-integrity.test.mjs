import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';

import { prepareCobolRelease } from '../producer/cobol-browser/scripts/package-release.mjs';
import { COBOL_ASSETS } from '../producer/cobol-browser/scripts/verify-artifacts.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cobol-release-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const source = path.join(directory, 'source');
	const output = path.join(directory, 'release');
	await fs.cp(path.join(repo, 'artifacts/cobol-browser'), source, { recursive: true });
	await fs.mkdir(path.join(output, 'obsolete'), { recursive: true });
	await fs.writeFile(path.join(output, 'obsolete/old-file'), 'preserve until publication');
	await fs.writeFile(path.join(output, 'runtime-manifest.v1.json'), 'previous manifest');
	return { directory, source, output };
}

async function tree(directory) {
	const result = [];
	async function visit(current, prefix = '') {
		for (const name of (await fs.readdir(current)).sort()) {
			const relative = `${prefix}${name}`;
			const absolute = path.join(current, name);
			if ((await fs.stat(absolute)).isDirectory()) await visit(absolute, `${relative}/`);
			else result.push([relative, sha256(await fs.readFile(absolute))]);
		}
	}
	await visit(directory);
	return result;
}

test('COBOL release publishes verified assets and replaces the complete previous file set', async (t) => {
	const f = await fixture(t);
	await prepareCobolRelease(f.source, f.output);
	assert.deepEqual((await fs.readdir(f.output)).sort(), [...COBOL_ASSETS,
		'runtime-build.json', 'runtime-manifest.v1.json'].sort());
	const build = JSON.parse(await fs.readFile(path.join(f.output, 'runtime-build.json')));
	assert.deepEqual(build.toolchain, JSON.parse(await fs.readFile(path.join(f.source, 'toolchain.json'))));
	for (const asset of COBOL_ASSETS) {
		const bytes = await fs.readFile(path.join(f.source, asset));
		assert.deepEqual(await fs.readFile(path.join(f.output, asset)), bytes);
		assert.deepEqual(build.assets.find((value) => value.asset === asset), {
			asset, size: bytes.length, sha256: sha256(bytes)
		});
	}
	const manifest = JSON.parse(await fs.readFile(path.join(f.output, 'runtime-manifest.v1.json')));
	assert.equal(manifest.version, build.toolchain.version);
	assert.equal(manifest.frontend.asset, 'cobc.zip');
	await fs.writeFile(path.join(f.output, 'removed-feature'), 'stale');
	await prepareCobolRelease(f.source, f.output);
	assert.equal((await fs.readdir(f.output)).includes('removed-feature'), false);
	assert.deepEqual((await fs.readdir(f.directory)).sort(), ['release', 'source']);
});

test('COBOL release rejects corrupt, missing and structurally invalid inputs without changing previous output', async (t) => {
	const f = await fixture(t);
	const before = await tree(f.output);
	const compiler = await fs.readFile(path.join(f.source, 'cobc.zip'));
	await fs.writeFile(path.join(f.source, 'cobc.zip'), 'invalid compiler archive\n');
	await assert.rejects(prepareCobolRelease(f.source, f.output), /size does not match/);
	assert.deepEqual(await tree(f.output), before);
	await fs.writeFile(path.join(f.source, 'cobc.zip'), compiler);
	const writer = new ZipWriter(new Uint8ArrayWriter());
	await writer.add('rootfs.tar', new Uint8ArrayReader(Buffer.alloc(1024, 65)));
	const bytes = await writer.close();
	await fs.writeFile(path.join(f.source, 'rootfs.tar.zip'), bytes);
	const receipt = JSON.parse(await fs.readFile(path.join(f.source, 'toolchain.json')));
	receipt.assets['rootfs.tar.zip'] = { bytes: bytes.length, sha256: sha256(bytes) };
	await fs.writeFile(path.join(f.source, 'toolchain.json'), JSON.stringify(receipt));
	await assert.rejects(prepareCobolRelease(f.source, f.output), /TAR/);
	assert.deepEqual(await tree(f.output), before);
	await fs.rm(path.join(f.source, 'rootfs.tar.zip'));
	await assert.rejects(prepareCobolRelease(f.source, f.output), /ENOENT/);
	assert.deepEqual(await tree(f.output), before);
});

test('COBOL release refuses to replace its source or an ancestor, including a symlink alias', async (t) => {
	const f = await fixture(t);
	const sourceBefore = await tree(f.source);
	const outputBefore = await tree(f.output);
	const alias = path.join(f.directory, 'source-alias');
	await fs.symlink(f.source, alias, 'junction');
	for (const target of [f.source, f.directory, alias]) {
		await assert.rejects(prepareCobolRelease(f.source, target), /must not replace its source directory or an ancestor/);
		assert.deepEqual(await tree(f.source), sourceBefore);
		assert.deepEqual(await tree(f.output), outputBefore);
	}
});

test('COBOL release preserves producer identity verification on its shared snapshot path', async (t) => {
	const f = await fixture(t);
	const before = await tree(f.output);
	const receipt = JSON.parse(await fs.readFile(path.join(f.source, 'toolchain.json')));
	receipt.producer.manifestSha256 = '0'.repeat(64);
	await fs.writeFile(path.join(f.source, 'toolchain.json'), JSON.stringify(receipt));
	await assert.rejects(prepareCobolRelease(f.source, f.output), /producer identity does not match/);
	assert.deepEqual(await tree(f.output), before);
});

test('COBOL release preserves all previous bytes after a late staged write failure', async (t) => {
	const f = await fixture(t);
	const before = await tree(f.output);
	const writeFile = fs.writeFile;
	fs.writeFile = async (filename, ...args) => {
		await writeFile(filename, ...args);
		if (path.basename(filename) === 'runtime-build.json') throw new Error('injected disk failure');
	};
	try {
		await assert.rejects(prepareCobolRelease(f.source, f.output), /injected disk failure/);
	} finally {
		fs.writeFile = writeFile;
	}
	assert.deepEqual(await tree(f.output), before);
	assert.deepEqual((await fs.readdir(f.directory)).sort(), ['release', 'source']);
});

test('COBOL release detects altered staged bytes before replacing previous output', async (t) => {
	const f = await fixture(t);
	const before = await tree(f.output);
	const writeFile = fs.writeFile;
	fs.writeFile = async (filename, bytes, ...args) => {
		await writeFile(filename, path.basename(filename) === 'cobc.zip' ? Buffer.from('damaged') : bytes, ...args);
	};
	try {
		await assert.rejects(prepareCobolRelease(f.source, f.output), /Staged COBOL release differs: cobc.zip/);
	} finally {
		fs.writeFile = writeFile;
	}
	assert.deepEqual(await tree(f.output), before);
	assert.deepEqual((await fs.readdir(f.directory)).sort(), ['release', 'source']);
});

test('COBOL release publishes the verified snapshot when source files change during staging', async (t) => {
	const f = await fixture(t);
	const compiler = await fs.readFile(path.join(f.source, 'cobc.zip'));
	const writeFile = fs.writeFile;
	let changed = false;
	fs.writeFile = async (filename, ...args) => {
		if (!changed && path.basename(filename) === 'cobc.zip') {
			changed = true;
			await writeFile(path.join(f.source, 'cobc.zip'), 'source changed after verification');
		}
		return writeFile(filename, ...args);
	};
	try {
		await prepareCobolRelease(f.source, f.output);
	} finally {
		fs.writeFile = writeFile;
	}
	assert.equal(changed, true);
	assert.deepEqual(await fs.readFile(path.join(f.output, 'cobc.zip')), compiler);
});
