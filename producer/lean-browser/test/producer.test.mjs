import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assemble, assetReceipts, producerInputs, verify } from '../scripts/package.mjs';

const producer = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const artifacts = path.resolve(producer, '../../artifacts/lean-browser');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('manifest pins Lean 4.34.1, its release bootstrap, and the local patch', async () => {
	const manifest = JSON.parse(await readFile(path.join(producer, 'manifest.json'), 'utf8'));
	assert.equal(manifest.sources.lean4.version, '4.34.1');
	assert.match(manifest.sources.lean4.commit, /^[0-9a-f]{40}$/);
	assert.match(manifest.bootstrap.url, /\/v4\.34\.1\/lean-4\.34\.1-linux\.tar\.zst$/);
	assert.match(manifest.bootstrap.sha256, /^[0-9a-f]{64}$/);
	for (const patch of manifest.patches) {
		assert.equal(sha256(await readFile(path.join(producer, patch.path))), patch.sha256);
	}
});

test('the patch only adapts the Emscripten runtime and keeps the upstream frontend', async () => {
	const patch = await readFile(path.join(producer, 'patches/0001-lean-browser-emscripten.patch'), 'utf8');
	const files = [...patch.matchAll(/^diff --git a\/(\S+)/gm)].map((match) => match[1]);
	assert.ok(files.length > 0);
	for (const file of files) assert.match(file, /^src\/(CMakeLists\.txt|runtime\/|library\/|util\/shell\.cpp)/);
	assert.ok(!files.some((file) => file.endsWith('.lean')), 'Lean sources must stay upstream');
});

test('symbol table prefers boxed entry points and stays sorted', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'lean-symtab-'));
	try {
		await writeFile(
			path.join(directory, 'a.c'),
			[
				'LEAN_EXPORT lean_object* l_b(lean_object* x_1, uint8_t x_2) {',
				'LEAN_EXPORT lean_object* l_b___boxed(lean_object* x_1, lean_object* x_2) {',
				'LEAN_EXPORT lean_object* l_a;',
				'LEAN_EXPORT uint8_t l_c(lean_object*);',
				''
			].join('\n')
		);
		const out = path.join(directory, 'symtab.c');
		execFileSync('python3', [path.join(producer, 'scripts/gen-symtab.py'), directory, out]);
		const table = await readFile(out, 'utf8');
		const names = [...table.matchAll(/^ {2}\{"(\w+)"/gm)].map((match) => match[1]);
		assert.deepEqual(names, ['l_a', 'l_b___boxed', 'l_c']);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

async function syntheticWork() {
	const work = await mkdtemp(path.join(os.tmpdir(), 'lean-package-'));
	await mkdir(path.join(work, 'dist'), { recursive: true });
	await mkdir(path.join(work, 'lean4'), { recursive: true });
	await mkdir(path.join(work, 'build-wasm/libuv/src/libuv'), { recursive: true });
	await mkdir(path.join(work, 'olean32/Init/Data'), { recursive: true });
	await writeFile(path.join(work, 'dist/lean.mjs'), 'export default async () => ({});\n');
	await writeFile(path.join(work, 'dist/lean.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
	await writeFile(path.join(work, 'lean4/LICENSE'), 'Apache License 2.0\n');
	await writeFile(path.join(work, 'build-wasm/libuv/src/libuv/LICENSE'), 'MIT\n');
	for (const module of ['Init', 'Init/Data/Basic'])
		for (const ext of ['.olean', '.olean.server', '.olean.private', '.ir', '.ir.sig'])
			await writeFile(path.join(work, 'olean32', `${module}${ext}`), `${module}${ext}\n`);
	await writeFile(path.join(work, 'olean32/Init.fail.log'), 'ignored\n');
	return work;
}

test('packaging indexes every library part and verification detects tampering', async () => {
	const work = await syntheticWork();
	const release = path.join(work, 'release');
	try {
		const { files, wasm } = await assemble(work);
		const index = JSON.parse(files.get('lean-init.index.json'));
		assert.equal(index.modules, 2);
		assert.deepEqual(
			index.files.map((file) => file.path),
			[
				'Init.ir',
				'Init.ir.sig',
				'Init.olean',
				'Init.olean.private',
				'Init.olean.server',
				'Init/Data/Basic.ir',
				'Init/Data/Basic.ir.sig',
				'Init/Data/Basic.olean',
				'Init/Data/Basic.olean.private',
				'Init/Data/Basic.olean.server'
			]
		);
		await mkdir(release);
		for (const [name, bytes] of files) await writeFile(path.join(release, name), bytes);
		const inputs = await producerInputs();
		await writeFile(
			path.join(release, 'producer-receipt.json'),
			JSON.stringify({
				manifestSha256: inputs.manifestSha256,
				patches: inputs.patches,
				recipe: inputs.recipe,
				assets: assetReceipts(files, wasm),
				acceptance: { node: { program: { stdout: 'Hello, 안녕!\nsum = 40\n' } } }
			})
		);
		assert.equal((await verify(release)).modules, 2);
		const chunk = path.join(release, index.chunks[0].path);
		const bytes = await readFile(chunk);
		bytes[bytes.length - 9] ^= 1;
		await writeFile(chunk, bytes);
		await assert.rejects(verify(release), /does not match the receipt/);
		await writeFile(path.join(release, 'extra.txt'), 'x');
		await assert.rejects(verify(release), /unexpected release entries|does not match/);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
});

test('committed release matches its receipt', { skip: !existsSync(artifacts) }, async () => {
	const result = await verify(artifacts);
	assert.ok(result.modules > 600);
	const receipt = JSON.parse(await readFile(path.join(artifacts, 'producer-receipt.json'), 'utf8'));
	assert.equal(receipt.acceptance.node.program.stdout, 'Hello, 안녕!\nsum = 40\n');
	assert.equal(receipt.acceptance.node.diagnostic.exitCode, 1);
});
