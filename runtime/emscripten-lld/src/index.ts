import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const EMSCRIPTEN_LLD_PROFILE = Object.freeze({
	id: 'emscripten-lld',
	version: 1,
	llvmVersion: '16.0.4',
	llvmCommit: 'ae42196bc493ffe877a7e3dff8be32035dea4d07',
	assets: ['lld.wasm.gz', 'lld.data.gz'] as const
});

export const SHARED_LLD_WASM_ASSET = '../../shared/emscripten-lld/lld.wasm.gz';
export const SHARED_LLD_DATA_ASSET = '../../shared/emscripten-lld/lld.data.gz';

export interface EmscriptenLldAssetReferences {
	wasm: string;
	data: string;
}

export interface ValidateEmscriptenLldAssetsOptions {
	sourceAssetDir: string;
	sharedAssetDir: string;
}

export interface SyncCanonicalEmscriptenLldAssetsOptions {
	canonicalAssetDir: string;
	targetAssetDir: string;
}

export interface RewriteEmscriptenLldAssetsOptions {
	targetAssetDir: string;
	manifestPath: string;
	localWasmAsset: string;
	localDataAsset: string;
	sharedAssetReferences?: EmscriptenLldAssetReferences;
}

export async function validateSharedEmscriptenLldAssets({
	sourceAssetDir,
	sharedAssetDir
}: ValidateEmscriptenLldAssetsOptions) {
	const sourceStats = await Promise.all(
		EMSCRIPTEN_LLD_PROFILE.assets.map((asset) =>
			stat(path.join(sourceAssetDir, asset)).catch(() => null)
		)
	);
	if (sourceStats.every((assetStats) => !assetStats)) return false;
	if (sourceStats.some((assetStats) => !assetStats?.isFile())) {
		throw new Error(`incomplete Emscripten LLD assets in ${sourceAssetDir}`);
	}

	for (const asset of EMSCRIPTEN_LLD_PROFILE.assets) {
		const sourceBytes = await readFile(path.join(sourceAssetDir, asset));
		const sharedBytes = await readFile(path.join(sharedAssetDir, asset)).catch(() => null);
		if (!sharedBytes) {
			throw new Error(
				`shared Emscripten LLD asset was not found at ${path.join(sharedAssetDir, asset)}`
			);
		}
		if (!sourceBytes.equals(sharedBytes)) {
			throw new Error(
				`Emscripten LLD asset ${asset} differs from the canonical asset in ${sharedAssetDir}`
			);
		}
	}
	return true;
}

export async function syncCanonicalEmscriptenLldAssets({
	canonicalAssetDir,
	targetAssetDir
}: SyncCanonicalEmscriptenLldAssetsOptions) {
	await mkdir(targetAssetDir, { recursive: true });
	for (const asset of EMSCRIPTEN_LLD_PROFILE.assets) {
		const sourcePath = path.join(canonicalAssetDir, asset);
		const sourceStats = await stat(sourcePath).catch(() => null);
		if (!sourceStats?.isFile()) {
			throw new Error(`canonical Emscripten LLD asset was not found at ${sourcePath}`);
		}
		await cp(sourcePath, path.join(targetAssetDir, asset));
	}
	return { canonicalAssetDir, targetAssetDir, assets: EMSCRIPTEN_LLD_PROFILE.assets };
}

export async function rewriteSharedEmscriptenLldAssets({
	targetAssetDir,
	manifestPath,
	localWasmAsset,
	localDataAsset,
	sharedAssetReferences = {
		wasm: SHARED_LLD_WASM_ASSET,
		data: SHARED_LLD_DATA_ASSET
	}
}: RewriteEmscriptenLldAssetsOptions) {
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
	let replacements = 0;
	const replaceReferences = (value: unknown): unknown => {
		if (Array.isArray(value)) {
			return value.map(replaceReferences);
		}
		if (value && typeof value === 'object') {
			for (const [key, child] of Object.entries(value)) {
				(value as Record<string, unknown>)[key] = replaceReferences(child);
			}
			return value;
		}
		if (value === localWasmAsset) {
			replacements += 1;
			return sharedAssetReferences.wasm;
		}
		if (value === localDataAsset) {
			replacements += 1;
			return sharedAssetReferences.data;
		}
		return value;
	};
	const rewrittenManifest = replaceReferences(manifest);
	if (replacements === 0) {
		throw new Error(`no Emscripten LLD references were found in ${manifestPath}`);
	}

	await writeFile(manifestPath, `${JSON.stringify(rewrittenManifest, null, 2)}\n`, 'utf8');
	await Promise.all(
		EMSCRIPTEN_LLD_PROFILE.assets.map((asset) =>
			rm(path.join(targetAssetDir, asset), { force: true })
		)
	);
}
