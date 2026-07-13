import { describe, expect, it } from 'vitest';
import { discoverEmceptionAssetNames, patchEmceptionWorkerSource } from '../src/index.js';

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
});
