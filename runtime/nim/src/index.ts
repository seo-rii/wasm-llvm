import { stat } from 'node:fs/promises';
import path from 'node:path';

export const NIM_LLVM_PROFILE = Object.freeze({
	id: 'nim-llvm8',
	version: 1,
	nimVersion: '2.2.4',
	llvmVersion: '8.0.1',
	resourceDir: '/lib/clang/8.0.1',
	requiredAssets: [
		'clang/clang.js',
		'clang/clang.wasm',
		'clang/lld.wasm',
		'clang/memfs.wasm',
		'clang/sysroot.tar'
	] as const
});

export async function validateNimLlvmProfile(sourceDir: string) {
	const missing: string[] = [];
	for (const relativePath of NIM_LLVM_PROFILE.requiredAssets) {
		const fileStats = await stat(path.join(sourceDir, relativePath)).catch(() => null);
		if (!fileStats?.isFile()) missing.push(relativePath);
	}
	if (missing.length > 0) {
		throw new Error(`Nim LLVM profile is incomplete: ${missing.join(', ')}`);
	}
	return {
		profile: NIM_LLVM_PROFILE,
		assetRoot: path.resolve(sourceDir)
	};
}
