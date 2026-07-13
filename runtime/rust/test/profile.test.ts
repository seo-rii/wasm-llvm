import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateRustLlvmProfile } from '../src/index.js';
import { createTemporaryDirectory } from '../../test-support.js';

describe('Rust LLVM profile', () => {
	it('keeps the Rust LLVM worker ABI separate from shared LLD assets', async () => {
		const root = await createTemporaryDirectory('wasm-llvm-rust-');
		await mkdir(path.join(root, 'runtime', 'llvm'), { recursive: true });
		await writeFile(
			path.join(root, 'runtime', 'runtime-manifest.v3.json'),
			JSON.stringify({ manifestVersion: 3 })
		);
		await writeFile(path.join(root, 'runtime', 'llvm', 'llc.wasm.gz'), 'llc');

		await expect(validateRustLlvmProfile(root)).resolves.toMatchObject({
			profile: { id: 'rustc-llvm-worker', version: 1 },
			hasEmscriptenLld: false
		});
	});
});
