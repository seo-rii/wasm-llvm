import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { refreshClangdAssets } from '../producer/clang-browser/scripts/refresh-clangd-assets.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function stdinWasm() {
	const name = Buffer.from('__asyncjs__waitForStdin');
	const imports = Buffer.concat([
		Buffer.from([1, 3]),
		Buffer.from('env'),
		Buffer.from([name.length]),
		name,
		Buffer.from([0, 0])
	]);
	return Buffer.concat([
		Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 2, imports.length]),
		imports
	]);
}

async function fixture(t, gzInput = false) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'clangd-assets-refresh-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = path.join(root, 'source');
	const prepared = path.join(root, 'prepared');
	await mkdir(path.join(source, 'clangd'), { recursive: true });
	await mkdir(prepared);
	const wasm = stdinWasm();
	const sourceFiles = new Map([
		...['clang.zip', 'lld.zip', 'memfs.zip', 'sysroot.tar.zip'].map((name) => [
			name,
			Buffer.from(`preserved ${name}`)
		]),
		[
			'clangd/clangd.js',
			Buffer.from('function stdin(){return Module.stdinReady()} // original')
		],
		['clangd/clangd.wasm.gz', gzipSync(wasm)],
		['memfs-build-receipt.json', Buffer.from('{"preserved":"receipt fixture"}')],
		['LICENSE.memfs-llvm.txt', Buffer.from('preserved license bytes')],
		['component-refresh-recipe.mjs', Buffer.from('// preserved historical recipe')]
	]);
	const metadata = {
		producer: { id: 'wasm-llvm/clang-browser', manifestSha256: 'old', extra: 'preserved' },
		version: 'llvmorg-22.1.8',
		llvmCommit: 'fixture-commit',
		resourceDir: '/lib/clang/22',
		clangd: {
			stdinBridge: 'emscripten-asyncify',
			patch: 'historical.patch',
			custom: 'preserved'
		},
		componentDerivation: { format: 'previous-refresh', preserved: { nested: ['unchanged'] } },
		assets: Object.fromEntries(
			[...sourceFiles]
				.filter(
					([name]) =>
						!name.endsWith('.json') && !name.endsWith('.txt') && !name.endsWith('.mjs')
				)
				.map(([name, bytes]) => [name, sha256(bytes)])
		)
	};
	sourceFiles.set('toolchain.json', Buffer.from(JSON.stringify(metadata)));
	for (const [name, bytes] of sourceFiles) await writeFile(path.join(source, name), bytes);
	const js = Buffer.from('function stdin(){return Module.stdinReady()} // separated');
	const wasmGz = gzipSync(wasm, { level: 6 });
	await writeFile(path.join(prepared, 'clangd.js'), js);
	await writeFile(
		path.join(prepared, gzInput ? 'clangd.wasm.gz' : 'clangd.wasm'),
		gzInput ? wasmGz : wasm
	);
	const tree = {
		schemaVersion: 1,
		version: 'llvmorg-22.1.8:fixture-commit',
		targetTriple: 'wasm32-wasi',
		resourceDir: '/lib/clang/22',
		files: {
			'/usr/include/wasm32-wasi/stdio.h': 'selected C header',
			'/usr/include/c++/v1/vector': 'selected C++ header',
			'/lib/clang/22/include/stddef.h': 'matching resource header'
		}
	};
	const headersRaw = Buffer.from(JSON.stringify(tree));
	const headersGz = gzipSync(headersRaw);
	await writeFile(path.join(prepared, 'clangd.headers.json.gz'), headersGz);
	const buildReceipt = path.join(root, 'relink.json');
	const command = {
		cwd: '/actual/build',
		argv: ['/pinned/em++', '-pthread', '-o', path.join(prepared, 'clangd.js')]
	};
	await writeFile(buildReceipt, JSON.stringify(command));
	const options = {
		sourceArtifacts: source,
		clangdDir: prepared,
		outDir: path.join(root, 'staged'),
		buildReceipt
	};
	return {
		root,
		source,
		prepared,
		sourceFiles,
		metadata,
		js,
		wasm,
		wasmGz,
		tree,
		headersRaw,
		headersGz,
		command,
		options
	};
}

test('stages only clangd changes, preserving every other file and historical receipt field', async (t) => {
	const f = await fixture(t);
	const result = await refreshClangdAssets(f.options);
	const metadata = JSON.parse(
		await readFile(path.join(result.directory, 'toolchain.json'), 'utf8')
	);
	for (const [name, bytes] of f.sourceFiles) {
		assert.deepEqual(
			await readFile(path.join(f.source, name)),
			bytes,
			`source unchanged: ${name}`
		);
		if (!['toolchain.json', 'clangd/clangd.js', 'clangd/clangd.wasm.gz'].includes(name))
			assert.deepEqual(
				await readFile(path.join(result.directory, name)),
				bytes,
				`preserved output: ${name}`
			);
	}
	assert.deepEqual(metadata.componentDerivation, f.metadata.componentDerivation);
	assert.equal(metadata.producer.extra, 'preserved');
	assert.equal(metadata.clangd.custom, 'preserved');
	assert.equal(metadata.clangd.stdinBridge, 'emscripten-asyncify');
	assert.equal(metadata.clangd.patch, 'historical.patch');
	assert.equal(metadata.clangd.headers.version, sha256(f.headersRaw));
	assert.equal(metadata.clangd.headers.sha256, sha256(f.headersGz));
	assert.equal(metadata.clangd.headers.uncompressedBytes, f.headersRaw.length);
	assert.equal(metadata.clangd.headerSeparation.inputs.wasm.uncompressedSha256, sha256(f.wasm));
	assert.equal(
		metadata.clangd.headerSeparation.outputs['clangd/clangd.wasm.gz'].uncompressedSha256,
		sha256(f.wasm)
	);
	assert.equal(
		metadata.clangd.headerSeparation.outputs['clangd/clangd.headers.json.gz']
			.uncompressedSha256,
		sha256(f.headersRaw)
	);
	assert.deepEqual(metadata.clangd.headerSeparation.buildCommand.receipt, f.command);
	assert.equal(
		metadata.clangd.headerSeparation.sourceToolchain.sha256,
		sha256(f.sourceFiles.get('toolchain.json'))
	);
	const manifest = await readFile(
		new URL('../producer/clang-browser/manifest.json', import.meta.url)
	);
	assert.equal(metadata.producer.manifestSha256, sha256(manifest));
	assert.deepEqual(await readFile(path.join(result.directory, 'clangd/clangd.js')), f.js);
	assert.deepEqual(
		await readFile(path.join(result.directory, 'clangd/clangd.headers.json.gz')),
		f.headersGz
	);
	assert.equal(Object.keys(metadata.assets).length, 7);
});

test('preserves supplied gzip bytes and appends prior header-separation provenance on another staged refresh', async (t) => {
	const f = await fixture(t, true);
	const result = await refreshClangdAssets(f.options);
	assert.deepEqual(
		await readFile(path.join(result.directory, 'clangd/clangd.wasm.gz')),
		f.wasmGz
	);
	const firstMetadata = JSON.parse(
		await readFile(path.join(result.directory, 'toolchain.json'), 'utf8')
	);
	const second = await refreshClangdAssets({
		...f.options,
		sourceArtifacts: result.directory,
		outDir: path.join(f.root, 'second')
	});
	const secondMetadata = JSON.parse(
		await readFile(path.join(second.directory, 'toolchain.json'), 'utf8')
	);
	assert.deepEqual(
		secondMetadata.clangd.headerSeparation.previous,
		firstMetadata.clangd.headerSeparation
	);
	assert.deepEqual(secondMetadata.componentDerivation, f.metadata.componentDerivation);
});

test('rejects corrupt source assets and incomplete or mismatched prepared headers before creating output', async (t) => {
	const f = await fixture(t);
	await writeFile(path.join(f.source, 'clang.zip'), 'corrupt source');
	await assert.rejects(refreshClangdAssets(f.options), /Hash mismatch for clang.zip/);
	assert.equal(await stat(f.options.outDir).catch(() => null), null);
	await writeFile(path.join(f.source, 'clang.zip'), f.sourceFiles.get('clang.zip'));
	f.tree.version = 'different version';
	await writeFile(
		path.join(f.prepared, 'clangd.headers.json.gz'),
		gzipSync(Buffer.from(JSON.stringify(f.tree)))
	);
	await assert.rejects(refreshClangdAssets(f.options), /do not match source toolchain/);
	f.tree.version = 'llvmorg-22.1.8:fixture-commit';
	delete f.tree.files['/usr/include/c++/v1/vector'];
	await writeFile(
		path.join(f.prepared, 'clangd.headers.json.gz'),
		gzipSync(Buffer.from(JSON.stringify(f.tree)))
	);
	await assert.rejects(refreshClangdAssets(f.options), /Required clangd asset header is missing/);
	assert.equal(await stat(f.options.outDir).catch(() => null), null);
});

test('requires the actual stdin bridge in prepared modules', async (t) => {
	const f = await fixture(t);
	await writeFile(
		path.join(f.prepared, 'clangd.wasm'),
		Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])
	);
	await assert.rejects(refreshClangdAssets(f.options), /missing the Asyncify stdin import/);
	assert.equal(await stat(f.options.outDir).catch(() => null), null);
});

test('rejects overlapping or non-empty output directories without changing their files', async (t) => {
	const f = await fixture(t);
	for (const outDir of [f.source, path.join(f.source, 'nested'), f.prepared, f.root]) {
		await assert.rejects(refreshClangdAssets({ ...f.options, outDir }), /outside and disjoint/);
	}
	await mkdir(f.options.outDir);
	await writeFile(path.join(f.options.outDir, 'existing.txt'), 'keep');
	await assert.rejects(refreshClangdAssets(f.options), /empty or absent/);
	assert.equal(await readFile(path.join(f.options.outDir, 'existing.txt'), 'utf8'), 'keep');
});
