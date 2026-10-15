import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assemble, assetReceipts, packageRelease, producerInputs, verify } from '../scripts/package.mjs';

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
				schemaVersion: 1,
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

async function syntheticRelease(work) {
	const { files, wasm } = await assemble(work);
	const release = path.join(work, 'release');
	await mkdir(release);
	for (const [name, bytes] of files) await writeFile(path.join(release, name), bytes);
	const inputs = await producerInputs();
	const receipt = {
		schemaVersion: 1,
		manifestSha256: inputs.manifestSha256,
		patches: inputs.patches,
		recipe: inputs.recipe,
		assets: assetReceipts(files, wasm),
		acceptance: { node: { program: { stdout: 'Hello, 안녕!\nsum = 40\n' } } }
	};
	return { release, receipt, files };
}

test('package acceptance failure preserves an existing release', async () => {
	const work = await syntheticWork();
	const outDir = path.join(work, 'release');
	try {
		await mkdir(outDir);
		await writeFile(path.join(outDir, 'prior-release'), 'unchanged bytes');
		// This valid Wasm fixture deliberately has no Lean runtime API.
		await assert.rejects(packageRelease({ workDir: work, outDir }));
		assert.equal(await readFile(path.join(outDir, 'prior-release'), 'utf8'), 'unchanged bytes');
	} finally { await rm(work, { recursive: true, force: true }); }
});

test('requalification cannot rewrite original assets, source pins or build recipes', async () => {
	const work = await syntheticWork();
	try {
		const { release, receipt } = await syntheticRelease(work);
		const original = structuredClone(receipt);
		for (const mutate of [
			(value) => { value.assets['lean.mjs'].sha256 = '0'.repeat(64); },
			(value) => { value.sources = { lean4: { commit: '0'.repeat(40) } }; },
			(value) => { value.recipe['scripts/build.sh'] = '0'.repeat(64); }
		]) {
			const altered = structuredClone(original);
			mutate(altered);
			receipt.requalification = {
				kind: 'same-byte-repackage', compilerRebuilt: false,
				originalReceipt: altered,
				originalReceiptSha256: sha256(`${JSON.stringify(altered, null, '\t')}\n`)
			};
			await writeFile(path.join(release, 'producer-receipt.json'), JSON.stringify(receipt));
			await assert.rejects(verify(release), /requalification changed/);
		}
	} finally { await rm(work, { recursive: true, force: true }); }
});

test('requires runtime and license assets independently of the receipt', async () => {
	const work = await syntheticWork();
	try {
		const { release, receipt, files } = await syntheticRelease(work);
		for (const name of ['lean.mjs', 'lean.wasm.gz', 'LICENSE', 'LICENSE.libuv', 'lean-init.index.json']) {
			const broken = structuredClone(receipt);
			delete broken.assets[name];
			await rm(path.join(release, name));
			await writeFile(path.join(release, 'producer-receipt.json'), JSON.stringify(broken));
			await assert.rejects(verify(release), /missing required asset/);
			await writeFile(path.join(release, name), files.get(name));
		}
	} finally { await rm(work, { recursive: true, force: true }); }
});

test('rejects unsafe library paths, sizes, duplicate ranges and incomplete module parts', async () => {
	const work = await syntheticWork();
	try {
		const { release, receipt, files } = await syntheticRelease(work);
		const mutations = [
			(index) => { index.chunks[0].path = '../outside.gz'; },
			(index) => { index.chunks[0].path = 'lean-init-99.pack.gz'; },
			(index) => { index.chunks.push(index.chunks[0]); },
			(index) => { index.chunks[0].uncompressedBytes = Number.MAX_SAFE_INTEGER; },
			(index) => { index.chunks[0].offset = -1; },
			(index) => { index.files[0].bytes = -1; },
			(index) => { index.files[0].bytes = 0.5; },
			(index) => { index.files[0].bytes = Number.MAX_SAFE_INTEGER + 1; },
			(index) => { index.files[1].offset--; },
			(index) => { index.files[1].path = index.files[0].path; },
			(index) => { index.files[0].path = 'Init/Other.ir'; },
			(index) => { index.modules++; },
			(index) => { index.schemaVersion = 999; }
		];
		for (const mutate of mutations) {
			const index = JSON.parse(files.get('lean-init.index.json'));
			mutate(index);
			const bytes = Buffer.from(JSON.stringify(index));
			receipt.assets['lean-init.index.json'] = { bytes: bytes.length, sha256: sha256(bytes) };
			await writeFile(path.join(release, 'lean-init.index.json'), bytes);
			await writeFile(path.join(release, 'producer-receipt.json'), JSON.stringify(receipt));
			await assert.rejects(verify(release), /invalid library|library chunks|library module/);
		}
	} finally { await rm(work, { recursive: true, force: true }); }
});

test('bounds Wasm and library decompression by validated declared sizes', async () => {
	const work = await syntheticWork();
	try {
		const { release, receipt, files } = await syntheticRelease(work);
		for (const size of [-1, Number.MAX_SAFE_INTEGER, 7]) {
			const broken = structuredClone(receipt);
			broken.assets['lean.wasm.gz'].uncompressed.bytes = size;
			await writeFile(path.join(release, 'producer-receipt.json'), JSON.stringify(broken));
			await assert.rejects(verify(release), /uncompressed receipt|larger than/);
		}
		const index = JSON.parse(files.get('lean-init.index.json'));
		index.totalBytes--;
		index.chunks[0].uncompressedBytes--;
		index.files.at(-1).bytes--;
		const bytes = Buffer.from(JSON.stringify(index));
		receipt.assets['lean-init.index.json'] = { bytes: bytes.length, sha256: sha256(bytes) };
		await writeFile(path.join(release, 'lean-init.index.json'), bytes);
		await writeFile(path.join(release, 'producer-receipt.json'), JSON.stringify(receipt));
		await assert.rejects(verify(release), /larger than/);
	} finally { await rm(work, { recursive: true, force: true }); }
});

test('committed release matches its receipt', { skip: !existsSync(artifacts) }, async () => {
	const result = await verify(artifacts);
	assert.ok(result.modules > 600);
	const receipt = JSON.parse(await readFile(path.join(artifacts, 'producer-receipt.json'), 'utf8'));
	assert.equal(receipt.acceptance.node.program.stdout, 'Hello, 안녕!\nsum = 40\n');
	assert.equal(receipt.acceptance.node.diagnostic.exitCode, 1);
	assert.equal(receipt.requalification.kind, 'same-byte-repackage');
	assert.equal(receipt.requalification.compilerRebuilt, false);
	const original = receipt.requalification.originalReceipt;
	for (const field of ['assets', 'sources', 'bootstrap', 'patches', 'manifestSha256', 'runtime'])
		assert.deepEqual(receipt[field], original[field]);
	assert.equal(receipt.recipe['scripts/build.sh'], original.recipe['scripts/build.sh']);
	assert.notEqual(receipt.recipe['scripts/package.mjs'], original.recipe['scripts/package.mjs']);
	assert.equal(sha256(`${JSON.stringify(original, null, '\t')}\n`), receipt.requalification.originalReceiptSha256);
});
