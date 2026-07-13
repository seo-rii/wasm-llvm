import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateRustLlvmProfile } from '../src/index.js';
import { createTemporaryDirectory } from '../../test-support.js';

describe('Rust LLVM profile', () => {
	it('keeps the Rust LLVM worker ABI separate from shared LLD assets', async () => {
		const root = await createTemporaryDirectory('wasm-llvm-rust-');
		await mkdir(path.join(root, 'runtime', 'rustc'), { recursive: true });
		await mkdir(path.join(root, 'runtime', 'llvm'), { recursive: true });
		await writeFile(
			path.join(root, 'runtime', 'runtime-manifest.v3.json'),
			JSON.stringify({
				manifestVersion: 3,
				version: 'rust-1.79.0-dev-browser-split-v3',
				compiler: { rustcWasm: 'rustc/rustc.wasm.gz' },
				targets: {
					'wasm32-wasip1': {
						compile: {
							llvm: {
								llc: 'llvm/llc.js',
								llcWasm: 'llvm/llc.wasm.gz',
								lld: 'llvm/lld.js',
								lldWasm: 'llvm/lld.wasm.gz',
								lldData: 'llvm/lld.data.gz'
							}
						}
					}
				}
			})
		);
		await writeFile(path.join(root, 'runtime', 'rustc', 'rustc.wasm.gz'), 'rustc');
		await writeFile(path.join(root, 'runtime', 'llvm', 'llc.js'), 'llc');
		await writeFile(path.join(root, 'runtime', 'llvm', 'llc.wasm.gz'), 'llc');
		await writeFile(path.join(root, 'runtime', 'llvm', 'lld.js'), 'lld');

		await expect(validateRustLlvmProfile(root)).resolves.toMatchObject({
			profile: { id: 'rustc-llvm-worker', version: 2 },
			hasEmscriptenLld: false
		});
	});
});
