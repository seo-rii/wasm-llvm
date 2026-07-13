import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const RUST_LLVM_PROFILE = Object.freeze({
	id: 'rustc-llvm-worker',
	version: 2,
	rustVersion: '1.79.0-dev-browser-split-v3',
	rustcLlvmVersion: '18.1.3',
	rustcLlvmCommit: 'af8f9eb15a2fc282f2ec1f34cd75c16c69ab9982',
	browserLlvmVersion: '16.0.4',
	browserLlvmCommit: 'ae42196bc493ffe877a7e3dff8be32035dea4d07',
	llvmVersion: '16.0.4',
	llvmCommit: 'ae42196bc493ffe877a7e3dff8be32035dea4d07',
	manifest: 'runtime/runtime-manifest.v3.json',
	requiredAssets: [
		'runtime/rustc/rustc.wasm.gz',
		'runtime/llvm/llc.js',
		'runtime/llvm/llc.wasm.gz',
		'runtime/llvm/lld.js'
	] as const,
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
		version?: string;
		compiler?: { rustcWasm?: string };
		targets?: Record<
			string,
			{
				compile?: {
					llvm?: {
						llc?: string;
						llcWasm?: string;
						lld?: string;
						lldWasm?: string;
						lldData?: string;
					};
				};
			}
		>;
	};
	if (manifest.manifestVersion !== 3) {
		throw new Error(`Rust LLVM profile requires runtime manifest version 3`);
	}
	if (manifest.version !== `rust-${RUST_LLVM_PROFILE.rustVersion}`) {
		throw new Error(`Rust LLVM profile requires ${RUST_LLVM_PROFILE.rustVersion}`);
	}
	if (manifest.compiler?.rustcWasm !== 'rustc/rustc.wasm.gz') {
		throw new Error('Rust LLVM profile has an unexpected rustc asset');
	}
	const targets = Object.entries(manifest.targets ?? {});
	if (targets.length === 0) throw new Error('Rust LLVM profile does not define any targets');
	for (const [target, config] of targets) {
		const llvm = config.compile?.llvm;
		if (
			llvm?.llc !== 'llvm/llc.js' ||
			llvm.llcWasm !== 'llvm/llc.wasm.gz' ||
			llvm.lld !== 'llvm/lld.js' ||
			llvm.lldWasm !== 'llvm/lld.wasm.gz' ||
			llvm.lldData !== 'llvm/lld.data.gz'
		) {
			throw new Error(`Rust LLVM profile has unexpected LLVM assets for ${target}`);
		}
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
