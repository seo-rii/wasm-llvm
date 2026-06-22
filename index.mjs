import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRootDir = path.dirname(fileURLToPath(import.meta.url));
export const runtimeSourceDir = path.join(packageRootDir, 'artifacts', 'runtime-source');
export const runtimeSourceUrl = new URL('./artifacts/runtime-source/', import.meta.url);
export const toolchainMetadataPath = path.join(runtimeSourceDir, 'toolchain.json');

export function resolveRuntimeSourcePath(...segments) {
	return path.join(runtimeSourceDir, ...segments);
}

export default runtimeSourceDir;
