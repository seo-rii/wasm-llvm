import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	discoverEmceptionAssetNames,
	patchEmceptionWorkerSource,
	syncEmceptionRuntime
} from '../src/index.js';
import { createTemporaryDirectory } from '../../test-support.js';

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

describe('TinyGo LLVM profile', () => {
	it('patches and discovers emception runtime assets', () => {
		const patched = patchEmceptionWorkerSource(workerSource);
		expect(patched).toContain('__webpack_require__.p=new URL("./",self.location.href).href');
		expect(patched).toContain('cache-package.brotli');
		expect(discoverEmceptionAssetNames(patched)).toEqual(['cache-package.brotli']);
	});

	it('rejects a changed worker when a checksum is pinned', async () => {
		const root = await createTemporaryDirectory('wasm-llvm-tinygo-');
		await expect(
			syncEmceptionRuntime({
				workerUrl: 'https://example.test/emception.worker.js',
				outputPath: path.join(root, 'emception.worker.js'),
				expectedWorkerSha256: '0'.repeat(64),
				fetchImpl: async () => new Response(workerSource)
			})
		).rejects.toThrow('checksum mismatch');
	});
});
