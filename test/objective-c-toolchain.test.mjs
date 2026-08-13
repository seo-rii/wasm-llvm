import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRIVER_SCRIPTS = [
	'producer/objective-c-browser/scripts/probe-libffi.mjs'
];

test('uses the Clang frontend for GNUstep Objective-C Wasm objects', async () => {
	const relativePath = 'producer/objective-c-browser/scripts/build.mjs';
	const source = await readFile(path.join(REPO_ROOT, relativePath), 'utf8');
	assert.match(source, /['"]-cc1['"]/u);
	assert.match(source, /const target = ['"]wasm32-wasip1['"]/u);
	assert.match(source, /['"]-ferror-limit['"]\s*,\s*['"]20['"]/u);
	assert.match(source, /['"]-D_WASI_EMULATED_MMAN=1['"]/u);
});

test('uses the Clang frontend for GNUstep Foundation Wasm objects', async () => {
	const relativePath = 'producer/objective-c-browser/scripts/probe-foundation.mjs';
	const source = await readFile(path.join(REPO_ROOT, relativePath), 'utf8');
	assert.match(source, /function foundationCompileArgs[\s\S]*?['"]-cc1['"]/u);
	assert.match(source, /['"]wasm32-wasip1['"]/u);
	assert.match(source, /['"]-ferror-limit['"]\s*,\s*['"]20['"]/u);
	assert.match(source, /['"]-D_WASI_EMULATED_MMAN=1['"]/u);
});

test('uses WASI SDK 33 compatible Clang driver arguments in probes', async () => {
	for (const relativePath of DRIVER_SCRIPTS) {
		const source = await readFile(path.join(REPO_ROOT, relativePath), 'utf8');
		assert.doesNotMatch(source, /['"]--target=wasm32-wasi['"]/u, relativePath);
		assert.doesNotMatch(
			source,
			/['"]-ferror-limit['"]\s*,\s*['"]20['"]/u,
			relativePath
		);
		assert.match(source, /['"]--target=wasm32-wasip1['"]/u, relativePath);
		assert.match(source, /['"]-ferror-limit=20['"]/u, relativePath);
		assert.match(source, /['"]-D_WASI_EMULATED_MMAN=1['"]/u, relativePath);
	}
});

test('retains the official mmap emulation archive in the browser sysroot', async () => {
	const source = await readFile(
		path.join(REPO_ROOT, 'producer/clang-browser/scripts/build-toolchain.mjs'),
		'utf8'
	);
	assert.match(source, /['"]libwasi-emulated-mman\.a['"]/u);
});

test('validates libffi through its upstream EM_JS import ABI', async () => {
	const source = await readFile(
		path.join(REPO_ROOT, 'producer/objective-c-browser/scripts/probe-libffi.mjs'),
		'utf8'
	);
	assert.match(source, /emscriptenImportStubs: true/u);
	assert.match(source, /runLibffiRuntimeProbe\(headers\)/u);
	assert.doesNotMatch(source, /direct WASI compile .* is not ready/u);
});

test('does not overwrite aliased libobjc2 headers with empty content', async () => {
	const source = await readFile(
		path.join(REPO_ROOT, 'producer/objective-c-browser/scripts/probe-foundation.mjs'),
		'utf8'
	);
	assert.match(source, /return \{ path: aliasedHeader, aliasOnly: true \}/u);
	assert.match(source, /if \(resolved\.aliasOnly\) continue/u);
	assert.doesNotMatch(source, /return \{ path: aliasedHeader, source: ['"]['"] \}/u);
});

test('records and verifies the complete Objective-C Foundation asset set', async () => {
	const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
	const foundationSource = await readFile(
		path.join(REPO_ROOT, 'producer/objective-c-browser/scripts/probe-foundation.mjs'),
		'utf8'
	);
	const verifierSource = await readFile(
		path.join(REPO_ROOT, 'producer/objective-c-browser/scripts/verify-artifacts.mjs'),
		'utf8'
	);

	assert.equal(
		packageJson.scripts['verify:objective-c-artifacts'],
		'node ./producer/objective-c-browser/scripts/verify-artifacts.mjs'
	);
	assert.match(foundationSource, /finalizeObjectiveCReceipt\(/);
	for (const assetName of [
		'libobjc.a',
		'headers.json',
		'libgnustep-base.a',
		'libgnustep-base.o',
		'foundation-headers.json',
		'libffi.a'
	]) {
		assert.ok(verifierSource.includes(assetName));
	}
});

test('keeps host filesystem paths out of the Objective-C producer receipt', async () => {
	const source = await readFile(
		path.join(REPO_ROOT, 'producer/objective-c-browser/scripts/build.mjs'),
		'utf8'
	);

	assert.match(source, /wasiSdkVersion:\s*PRODUCER_MANIFEST\.toolchain\.wasiSdkVersion/u);
	assert.match(source, /clangVersion[\s\S]*?split\(\/\\r\?\\n\/, 1\)\[0\]/u);
	assert.doesNotMatch(source, /clang:\s*CLANG/u);
	assert.doesNotMatch(source, /sysroot:\s*SYSROOT/u);

	const finalizeSource = await readFile(
		path.join(REPO_ROOT, 'producer/objective-c-browser/scripts/write-receipt.mjs'),
		'utf8'
	);
	assert.match(finalizeSource, /wasiSdkVersion:\s*manifest\.toolchain\.wasiSdkVersion/u);
	assert.doesNotMatch(finalizeSource, /clang:\s*existingReceipt/u);
	assert.doesNotMatch(finalizeSource, /sysroot:\s*existingReceipt/u);
});
