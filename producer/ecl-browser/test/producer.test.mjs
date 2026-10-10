import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { loadForm } from '../scripts/harness.mjs';
import { assertOverlays, assertReceipt, producerRoot, readManifest, repoRoot, sha256, verify } from '../scripts/producer.mjs';

test('pins the upstream ECL 26.5.5 release and Emscripten 6.0.0', async () => {
	const manifest = await readManifest();
	assert.equal(manifest.producerId, 'wasm-llvm/ecl-browser');
	assert.deepEqual(
		{ version: manifest.sources.ecl.version, commit: manifest.sources.ecl.commit, license: manifest.sources.ecl.license },
		{ version: '26.5.5', commit: '74780fa2cd2874889793a657d55b557488d3e346', license: 'LGPL-2.1-or-later' }
	);
	assert.equal(manifest.sources.emsdk.version, '6.0.0');
	assert.deepEqual(manifest.patches, []);
	assert.ok(manifest.cross.configure.includes('--with-cmp=no'), 'the browser build uses the bytecode compiler');
	for (const flag of ['-sIMPORTED_MEMORY=1', '-sBINARYEN_EXTRA_PASSES=--spill-pointers', '-sSUPPORT_LONGJMP=wasm']) {
		assert.ok(manifest.link.flags.includes(flag), flag);
	}
	await assertOverlays(manifest);
});

test('rejects a changed entry-point overlay', async () => {
	const manifest = await readManifest();
	await assert.rejects(
		assertOverlays({ ...manifest, overlays: [{ ...manifest.overlays[0], sha256: '0'.repeat(64) }] }),
		/Overlay checksum mismatch/u
	);
});

test('rejects truncated or altered artifacts', () => {
	const bytes = Buffer.from('ecl wasm');
	const receipt = { bytes: bytes.length, sha256: sha256(bytes) };
	assert.doesNotThrow(() => assertReceipt(bytes, receipt, 'ecl.wasm'));
	assert.throws(() => assertReceipt(bytes.subarray(1), receipt, 'ecl.wasm'), /pinned size and SHA-256/u);
	assert.throws(() => assertReceipt(Buffer.from('ecl wasN'), receipt, 'ecl.wasm'), /pinned size and SHA-256/u);
});

test('the LOAD form reports conditions and always exits explicitly', () => {
	const form = loadForm('main.lisp');
	assert.match(form, /^\(handler-bind \(\(serious-condition /u);
	assert.match(form, /\(load "main\.lisp" :verbose nil :print nil\)/u);
	assert.match(form, /\(ext:quit 1\)/u);
	assert.match(form, /\(ext:quit 0\)\)$/u);
	assert.equal(form.split('(').length, form.split(')').length);
});

const artifacts = path.join(repoRoot, 'artifacts/ecl-browser');
test('committed artifacts verify and reject tampering', { skip: !(await stat(artifacts).catch(() => null)) }, async () => {
	const receipt = await verify(artifacts);
	assert.equal(receipt.sources.ecl.version, '26.5.5');
	const copy = await mkdtemp(path.join(os.tmpdir(), 'ecl-artifacts-'));
	try {
		await cp(artifacts, copy, { recursive: true });
		assert.equal(receipt.delivery['ecl.wasm.gz'].encoding, 'gzip');
		const compressed = await readFile(path.join(copy, 'ecl.wasm.gz'));
		compressed[compressed.length - 1] ^= 1;
		await writeFile(path.join(copy, 'ecl.wasm.gz'), compressed);
		await assert.rejects(verify(copy), /pinned size and SHA-256/u);
		// A re-encoded delivery with the right logical bytes still fails its pinned delivery hash.
		await writeFile(path.join(copy, 'ecl.wasm.gz'), gzipSync(gunzipSync(await readFile(path.join(artifacts, 'ecl.wasm.gz'))), { level: 1 }));
		await assert.rejects(verify(copy), /pinned size and SHA-256/u);
	} finally {
		await rm(copy, { recursive: true, force: true });
	}
});

test('fixtures exist for every acceptance input', async () => {
	for (const name of ['stdin.lisp', 'error.lisp', 'gc.lisp', 'recursion.lisp']) {
		assert.ok((await readFile(path.join(producerRoot, 'fixtures', name), 'utf8')).length > 0);
	}
});

test('distributes the runtime copyright notices without rewriting build evidence', async () => {
	const expected = await readFile(path.join(producerRoot, 'THIRD_PARTY_NOTICES.txt'));
	const delivered = await readFile(path.join(repoRoot, 'artifacts/ecl-browser-notices/THIRD_PARTY_NOTICES.txt'));
	assert.deepEqual(delivered, expected);
	for (const notice of ['GNU LESSER GENERAL PUBLIC LICENSE', 'Boehm', 'Symbolics', 'Emscripten'])
		assert.ok(delivered.toString('utf8').includes(notice), notice);
});
