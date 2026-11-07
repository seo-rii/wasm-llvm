import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeProvenanceFiles } from './package.mjs';

async function temporaryDirectory(t) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gcc-provenance-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	return directory;
}

test('provenance writes flat receipts and the actual nested EH patch without changing bytes', async (t) => {
	const directory = await temporaryDirectory(t);
	const patch = await fs.readFile(fileURLToPath(new URL('./patches/libstdcxx-wasi-eh-config.patch', import.meta.url)));
	const files = new Map([
		['compiler-build.json', Buffer.from('{"status":"built"}\n')],
		['patches/libstdcxx-wasi-eh-config.patch', patch]
	]);
	await writeProvenanceFiles(directory, files);
	for (const [name, bytes] of files) assert.deepEqual(await fs.readFile(path.join(directory, name)), bytes);
});

test('provenance validates every relative path before writing any file', async (t) => {
	const directory = await temporaryDirectory(t);
	for (const unsafe of ['../escape', '/absolute', 'patches/../escape', 'patches//empty', 'patches\\escape']) {
		await assert.rejects(writeProvenanceFiles(directory, new Map([
			['valid.json', Buffer.from('{}')], [unsafe, Buffer.from('invalid')]
		])), /Unsafe bundle path/);
		assert.deepEqual(await fs.readdir(directory), []);
	}
});

test('provenance never replaces an existing evidence file', async (t) => {
	const directory = await temporaryDirectory(t);
	const name = 'receipt.json';
	const original = Buffer.from('original evidence');
	await fs.writeFile(path.join(directory, name), original);
	await assert.rejects(writeProvenanceFiles(directory, new Map([[name, Buffer.from('replacement')]])), { code: 'EEXIST' });
	assert.deepEqual(await fs.readFile(path.join(directory, name)), original);
});
