import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	rewriteSharedEmscriptenLldAssets,
	syncCanonicalEmscriptenLldAssets,
	validateSharedEmscriptenLldAssets
} from '../src/index.js';
import { createTemporaryDirectory } from '../../test-support.js';

describe('Emscripten LLD profile', () => {
	it('validates canonical assets and rewrites bundle manifests', async () => {
		const root = await createTemporaryDirectory('wasm-llvm-emscripten-lld-');
		const sourceDir = path.join(root, 'source');
		const sharedDir = path.join(root, 'shared');
		await mkdir(sourceDir, { recursive: true });
		await mkdir(sharedDir, { recursive: true });
		for (const asset of ['lld.wasm.gz', 'lld.data.gz']) {
			await writeFile(path.join(sourceDir, asset), asset);
			await writeFile(path.join(sharedDir, asset), asset);
		}
		const manifestPath = path.join(root, 'runtime-manifest.json');
		await writeFile(
			manifestPath,
			JSON.stringify({ linker: { wasm: 'bin/lld.wasm.gz', data: 'bin/lld.data.gz' } })
		);

		await expect(
			validateSharedEmscriptenLldAssets({ sourceAssetDir: sourceDir, sharedAssetDir: sharedDir })
		).resolves.toBe(true);
		const syncedDir = path.join(root, 'synced');
		await syncCanonicalEmscriptenLldAssets({
			canonicalAssetDir: sharedDir,
			targetAssetDir: syncedDir
		});
		await expect(readFile(path.join(syncedDir, 'lld.data.gz'), 'utf8')).resolves.toBe(
			'lld.data.gz'
		);
		await rewriteSharedEmscriptenLldAssets({
			targetAssetDir: sourceDir,
			manifestPath,
			localWasmAsset: 'bin/lld.wasm.gz',
			localDataAsset: 'bin/lld.data.gz'
		});

		await expect(readFile(manifestPath, 'utf8')).resolves.toContain(
			'../../shared/emscripten-lld/lld.wasm.gz'
		);
		await expect(readFile(path.join(sourceDir, 'lld.wasm.gz'))).rejects.toThrow();
	});
});
