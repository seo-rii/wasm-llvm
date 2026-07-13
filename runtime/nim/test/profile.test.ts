import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NIM_LLVM_PROFILE, validateNimLlvmProfile } from '../src/index.js';
import { createTemporaryDirectory } from '../../test-support.js';

describe('Nim LLVM profile', () => {
	it('requires the complete pinned Clang and LLD bundle', async () => {
		const root = await createTemporaryDirectory('wasm-llvm-nim-');
		for (const relativePath of NIM_LLVM_PROFILE.requiredAssets) {
			const filePath = path.join(root, relativePath);
			await mkdir(path.dirname(filePath), { recursive: true });
			await writeFile(filePath, relativePath);
		}
		await expect(validateNimLlvmProfile(root)).resolves.toMatchObject({
			profile: { id: 'nim-llvm8', version: 1, llvmVersion: '8.0.1' }
		});
	});
});
