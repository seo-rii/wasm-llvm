import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { stripCompilerNames, rebindRootCompiler, deriveNameStrippedCompiler, ROOT_MANIFEST_PATH } from '../scripts/strip-compiler-names.mjs';

const header = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const custom = (name, payload = []) => Buffer.from([0, 1 + name.length + payload.length, name.length, ...Buffer.from(name), ...payload]);

test('removes only name custom sections and preserves execution and other metadata', () => {
	const executable = Buffer.from([1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 114, 117, 110, 0, 0, 10, 6, 1, 4, 0, 65, 42, 11]);
	const metadata = [custom('producers'), custom('.debug_info'), custom('target_features'), custom('not-name')];
	const without = Buffer.concat([header, executable, ...metadata]);
	const withNames = Buffer.concat([header, custom('name'), executable, ...metadata, custom('name')]);
	const stripped = stripCompilerNames(withNames);
	assert.deepEqual(stripped.output, without);
	assert.equal(stripped.removedSections, 2);
	assert.equal(stripped.removedBytes, withNames.length - without.length);
	assert.equal(new WebAssembly.Instance(new WebAssembly.Module(stripped.output)).exports.run(), 42);
	assert.deepEqual(stripCompilerNames(without).output, without);
});

test('rejects invalid and truncated Wasm instead of publishing partial output', () => {
	for (const bytes of [Buffer.alloc(0), Buffer.from('not wasm'), Buffer.concat([header, Buffer.from([0, 127, 4, 110, 97, 109, 101])])]) {
		assert.throws(() => stripCompilerNames(bytes), /valid WebAssembly/);
	}
});

function rootArchive(compilerSha256) {
	const source = Buffer.from(`${JSON.stringify({ compilerSha256, untouched: 'payload' }, null, 2)}\n`);
	const h = Buffer.alloc(512);
	h.write(ROOT_MANIFEST_PATH);
	h.write(`${source.length.toString(8).padStart(11, '0')}\0`, 124);
	h[156] = 48;
	return gzipSync(Buffer.concat([h, source, Buffer.alloc(512 - source.length), Buffer.alloc(1024)]));
}

test('changes only the root manifest compiler digest and preserves all other tar bytes', () => {
	const before = 'a'.repeat(64), after = 'b'.repeat(64);
	const source = rootArchive(before);
	const output = rebindRootCompiler(source, before, after);
	const originalTar = gunzipSync(source);
	const derivedTar = gunzipSync(output);
	assert.equal(derivedTar.length, originalTar.length);
	assert.deepEqual(derivedTar, Buffer.from(originalTar.toString().replace(before, after)));
	assert.throws(() => rebindRootCompiler(source, after, before), /does not bind input/);
	assert.throws(() => rebindRootCompiler(gzipSync(Buffer.alloc(1024)), before, after), /exactly one/);
});


test('derives reproducible artifacts without relabeling the original acceptance', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'tinygo-name-derivation-'));
	try {
		const compiler = Buffer.concat([header, custom('name')]);
		const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
		const archive = rootArchive(hash(compiler));
		const original = {
			schemaVersion: 6, format: 'wasm-llvm-tinygo-browser-compiler-v6', producerId: 'wasm-llvm/tinygo-browser',
			verification: { status: 'passed', identityMode: 'upstream-package-graph', acceptance: { status: 'passed', note: 'input only' } },
			assets: [['tinygo-compiler.wasm', compiler], ['tinygoroot.tar.gz', archive]].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }))
		};
		const originalBytes = Buffer.from(JSON.stringify(original));
		await Promise.all([
			writeFile(path.join(directory, 'tinygo-compiler.wasm'), compiler),
			writeFile(path.join(directory, 'tinygoroot.tar.gz'), archive),
			writeFile(path.join(directory, 'producer-receipt.json'), originalBytes)
		]);
		const first = await deriveNameStrippedCompiler({ inputDir: directory, outputDir: path.join(directory, 'out-1') });
		const second = await deriveNameStrippedCompiler({ inputDir: directory, outputDir: path.join(directory, 'out-2') });
		assert.deepEqual(first, second);
		assert.equal(first.inputReceipt.source, originalBytes.toString());
		assert.equal(first.inputReceipt.sha256, hash(originalBytes));
		assert.equal(first.transformation.acceptance, 'preserved-input-receipt-only');
		assert.equal(first.verification, undefined);
		assert.deepEqual(await readFile(path.join(directory, 'tinygo-compiler.wasm')), compiler);
		assert.deepEqual(await readFile(path.join(directory, 'out-1/tinygo-compiler.wasm')), header);
		await assert.rejects(deriveNameStrippedCompiler({ inputDir: directory, outputDir: path.join(directory, 'out-1') }), /EEXIST/);
		await writeFile(path.join(directory, 'tinygo-compiler.wasm'), header);
		await assert.rejects(deriveNameStrippedCompiler({ inputDir: directory, outputDir: path.join(directory, 'bad') }), /original receipt does not bind/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
