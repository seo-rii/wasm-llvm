import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { verifyClangArtifacts } from '../producer/clang-browser/scripts/verify-artifacts.mjs';
import { createClangdHeaderAsset } from '../producer/clang-browser/scripts/prepare-clangd-headers.mjs';
import {
	CLANGD_HEADER_ASSET,
	validateClangdHeaderMetadata,
	verifyClangdHeaderAsset
} from '../producer/clang-browser/scripts/clangd-header-asset-contract.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tree = () => ({
	schemaVersion: 1,
	version: 'llvmorg-22.1.8:fixture-commit',
	targetTriple: 'wasm32-wasi',
	resourceDir: '/lib/clang/22',
	files: {
		'/usr/include/wasm32-wasi/stdio.h': 'selected C header',
		'/usr/include/wasm32-wasi/noeh/c++/v1/__config_site': 'selected C++ configuration',
		'/usr/include/c++/v1/vector': 'shared C++ header',
		'/lib/clang/22/include/stddef.h': 'matching resource header'
	}
});

function headerAsset(headers = tree()) {
	const raw = Buffer.isBuffer(headers) ? headers : Buffer.from(JSON.stringify(headers));
	const compressed = gzipSync(raw);
	return {
		compressed,
		metadata: {
			asset: CLANGD_HEADER_ASSET,
			format: 'clangd-headers-v1',
			version: sha256(raw),
			targetTriple: 'wasm32-wasi',
			resourceDir: '/lib/clang/22',
			bytes: compressed.length,
			sha256: sha256(compressed),
			uncompressedBytes: raw.length,
			uncompressedSha256: sha256(raw)
		}
	};
}

async function artifactFixture(t, separateHeaders) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'clangd-artifacts-contract-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, 'clangd'));
	const name = Buffer.from('__asyncjs__waitForStdin');
	const imports = Buffer.concat([
		Buffer.from([1, 3]),
		Buffer.from('env'),
		Buffer.from([name.length]),
		name,
		Buffer.from([0, 0])
	]);
	const wasm = Buffer.concat([
		Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 2, imports.length]),
		imports
	]);
	const files = new Map([
		...['clang.zip', 'lld.zip', 'memfs.zip', 'sysroot.tar.zip'].map((name) => [
			name,
			Buffer.from(name)
		]),
		[
			'clangd/clangd.js',
			Buffer.from(
				'function __asyncjs__waitForStdin(){return Asyncify.handleAsync(async()=>{await Module.stdinReady()})}'
			)
		],
		['clangd/clangd.wasm.gz', gzipSync(wasm)]
	]);
	const metadata = { resourceDir: '/lib/clang/22', clangd: {}, assets: {} };
	if (separateHeaders) {
		const asset = headerAsset();
		files.set(CLANGD_HEADER_ASSET, asset.compressed);
		metadata.clangd.headers = asset.metadata;
	}
	for (const [name, bytes] of files) {
		await writeFile(path.join(root, name), bytes);
		metadata.assets[name] = sha256(bytes);
	}
	const writeMetadata = () =>
		writeFile(path.join(root, 'toolchain.json'), JSON.stringify(metadata));
	await writeMetadata();
	return { root, metadata, writeMetadata };
}

test('verifies legacy two-asset clangd bundles and separately versioned three-asset bundles', async (t) => {
	for (const headers of [false, true]) {
		const fixture = await artifactFixture(t, headers);
		assert.deepEqual(await verifyClangArtifacts(fixture.root), { assets: headers ? 7 : 6 });
	}
});

test('the producer manifest identifies the separately delivered clangd header asset as optional', async () => {
	const manifest = JSON.parse(
		await readFile(new URL('../producer/clang-browser/manifest.json', import.meta.url), 'utf8')
	);
	assert.ok(manifest.optionalOutputs.includes(CLANGD_HEADER_ASSET));
	assert.ok(!manifest.outputs.includes(CLANGD_HEADER_ASSET));
});

test('packages all selected C/C++ and matching resource files with deterministic paths and contents', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'clangd-header-package-contract-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const includeDir = path.join(root, 'include');
	const resourceIncludeDir = path.join(root, 'resource');
	const headers = tree();
	headers.files['/lib/clang/22/include/__stddef/size_t.h'] = 'nested resource header';
	headers.files['/usr/include/c++/v1/__config'] = 'shared C++ configuration';
	for (const [file, contents] of Object.entries(headers.files)) {
		const source = file.startsWith('/usr/include/')
			? path.join(includeDir, file.slice('/usr/include/'.length))
			: path.join(resourceIncludeDir, file.slice('/lib/clang/22/include/'.length));
		await mkdir(path.dirname(source), { recursive: true });
		await writeFile(source, contents);
	}
	const options = {
		includeDir,
		resourceIncludeDir,
		version: headers.version,
		targetTriple: headers.targetTriple,
		resourceDir: headers.resourceDir
	};
	const first = await createClangdHeaderAsset(options);
	assert.deepEqual(JSON.parse(first.toString('utf8')), headers);
	assert.deepEqual(await createClangdHeaderAsset(options), first);
	await writeFile(path.join(resourceIncludeDir, 'invalid.h'), Buffer.from([0xff]));
	await assert.rejects(createClangdHeaderAsset(options), /encoded data was not valid/);
});

test('validates the entire header tree and preserves selected configuration and resource headers', () => {
	const { compressed, metadata } = headerAsset();
	assert.deepEqual(verifyClangdHeaderAsset(compressed, metadata), tree());
	for (const file of [
		'/usr/include/../escape.h',
		'/tmp/unapproved.h',
		'/usr/include/has\\slash.h'
	]) {
		const headers = tree();
		headers.files[file] = 'invalid';
		const invalid = headerAsset(headers);
		assert.throws(
			() => verifyClangdHeaderAsset(invalid.compressed, invalid.metadata),
			/Invalid clangd header path/
		);
	}
	const missing = tree();
	delete missing.files['/lib/clang/22/include/stddef.h'];
	const invalid = headerAsset(missing);
	assert.throws(
		() => verifyClangdHeaderAsset(invalid.compressed, invalid.metadata),
		/Required clangd asset header is missing/
	);
});

test('rejects corrupt storage, stale raw fingerprints, mismatched target metadata and invalid UTF-8', () => {
	const { compressed, metadata } = headerAsset();
	assert.throws(
		() => verifyClangdHeaderAsset(Buffer.from('corrupt'), metadata),
		/compressed receipt/
	);
	assert.throws(
		() =>
			verifyClangdHeaderAsset(compressed, {
				...metadata,
				version: 'a'.repeat(64),
				uncompressedSha256: 'a'.repeat(64)
			}),
		/uncompressed receipt/
	);
	assert.throws(
		() => verifyClangdHeaderAsset(compressed, { ...metadata, targetTriple: 'wasm32-wasip2' }),
		/header tree metadata/
	);
	const invalid = headerAsset(Buffer.from([0xff]));
	assert.throws(() => verifyClangdHeaderAsset(invalid.compressed, invalid.metadata));
	for (const changes of [
		{ asset: '../clangd.headers.json.gz' },
		{ format: 'unknown' },
		{ version: 'stale' },
		{ resourceDir: '/lib/clang/../22' },
		{ uncompressedBytes: 128 * 1024 * 1024 + 1 }
	])
		assert.throws(
			() => validateClangdHeaderMetadata({ ...metadata, ...changes }),
			/Invalid clangd header asset metadata/
		);
});

test('rejects unreceipted header assets and a header resource directory from another toolchain', async (t) => {
	const fixture = await artifactFixture(t, true);
	const header = fixture.metadata.clangd.headers;
	delete fixture.metadata.clangd.headers;
	await fixture.writeMetadata();
	await assert.rejects(verifyClangArtifacts(fixture.root), /complete Clang producer asset set/);
	fixture.metadata.clangd.headers = header;
	fixture.metadata.resourceDir = '/lib/clang/21';
	await fixture.writeMetadata();
	await assert.rejects(verifyClangArtifacts(fixture.root), /resource directory does not match/);
});
