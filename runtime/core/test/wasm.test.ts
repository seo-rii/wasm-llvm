import * as zip from '@zip.js/zip.js';
import { describe, expect, it, vi } from 'vitest';

import { compile, getInstance, readBuffer } from '../src/wasm.js';

const emptyWasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);

async function zipDataUrl(filename: string, contents: Uint8Array) {
	const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter());
	await writer.add(filename, new zip.Uint8ArrayReader(contents));
	const archive = await writer.close();
	return `data:application/zip;base64,${Buffer.from(archive).toString('base64')}`;
}

describe('WebAssembly loading utilities', () => {
	it('extracts the first file from a zip response and reports completion', async () => {
		const progress = { set: vi.fn() };
		const url = await zipDataUrl('fixture.bin', Uint8Array.of(1, 2, 3, 4));

		await expect(readBuffer(url, progress)).resolves.toEqual(Uint8Array.of(1, 2, 3, 4));
		expect(progress.set).toHaveBeenLastCalledWith(1);
	});

	it('compiles zipped wasm and instantiates the resulting module', async () => {
		const url = await zipDataUrl('fixture.wasm', emptyWasm);
		const module = await compile(url);
		const instance = await getInstance(module, {});

		expect(module).toBeInstanceOf(WebAssembly.Module);
		expect(instance).toBeInstanceOf(WebAssembly.Instance);
	});
});
