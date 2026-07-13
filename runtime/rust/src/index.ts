import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const RUST_LLVM_PROFILE = Object.freeze({
	id: 'rustc-llvm-worker',
	version: 1,
	rustVersion: '1.79.0-dev-browser-split-v3',
	llvmVersion: '16.0.4',
	llvmCommit: 'ae42196bc493ffe877a7e3dff8be32035dea4d07',
	manifest: 'runtime/runtime-manifest.v3.json',
	requiredAssets: ['runtime/llvm/llc.wasm.gz'] as const,
	optionalLldAssets: ['runtime/llvm/lld.wasm.gz', 'runtime/llvm/lld.data.gz'] as const
});

export async function validateRustLlvmProfile(sourceDir: string) {
	const manifestPath = path.join(sourceDir, RUST_LLVM_PROFILE.manifest);
	const manifestStats = await stat(manifestPath).catch(() => null);
	if (!manifestStats?.isFile()) {
		throw new Error(`Rust LLVM runtime manifest was not found at ${manifestPath}`);
	}
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
		manifestVersion?: number;
	};
	if (manifest.manifestVersion !== 3) {
		throw new Error(`Rust LLVM profile requires runtime manifest version 3`);
	}
	for (const relativePath of RUST_LLVM_PROFILE.requiredAssets) {
		const fileStats = await stat(path.join(sourceDir, relativePath)).catch(() => null);
		if (!fileStats?.isFile()) throw new Error(`Rust LLVM asset was not found: ${relativePath}`);
	}
	const lldStats = await Promise.all(
		RUST_LLVM_PROFILE.optionalLldAssets.map((relativePath) =>
			stat(path.join(sourceDir, relativePath)).catch(() => null)
		)
	);
	if (lldStats.some(Boolean) && !lldStats.every((fileStats) => fileStats?.isFile())) {
		throw new Error('Rust LLVM profile has an incomplete Emscripten LLD pair');
	}
	return {
		profile: RUST_LLVM_PROFILE,
		manifestPath,
		llvmAssetDir: path.join(sourceDir, 'runtime', 'llvm'),
		hasEmscriptenLld: lldStats.every((fileStats) => fileStats?.isFile())
	};
}
