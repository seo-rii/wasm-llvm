import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
	discoverEmceptionAssetNames,
	patchEmceptionWorkerSource,
	syncEmceptionRuntime
} from '../scripts/sync.mjs';

const tempDirs = [];
const workerSource = [
	'e.exports=t.p+"cache-package.br"',
	[
		'if(!e)throw new Error("Automatic publicPath is not supported in this browser");',
		'e=e.replace(/#.*$/,""\u0029.replace(/\\?.*$/,""\u0029.replace(/\\/[^\\/]+$/,"/"),',
		'__webpack_require__.p=e'
	].join(''),
	'this.ready=this.#e(e,r,{onrunprocess:t,...a});',
	'globalThis.emception=Hn,i(Hn)'
].join('\n');

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

test('patches and discovers emception runtime assets', () => {
	const patched = patchEmceptionWorkerSource(workerSource);
	assert.match(patched, /__webpack_require__\.p=new URL\("\.\/",self\.location\.href\)\.href/u);
	assert.match(patched, /cache-package\.brotli/u);
	assert.deepEqual(discoverEmceptionAssetNames(patched), ['cache-package.brotli']);
});

test('rejects a changed worker when a checksum is pinned', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'wasm-llvm-tinygo-'));
	tempDirs.push(root);
	await assert.rejects(
		syncEmceptionRuntime({
			workerUrl: 'https://example.test/emception.worker.js',
			outputPath: path.join(root, 'emception.worker.js'),
			expectedWorkerSha256: '0'.repeat(64),
			fetchImpl: async () => new Response(workerSource)
		}),
		/checksum mismatch/u
	);
});
