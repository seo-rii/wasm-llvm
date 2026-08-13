import { stat, statfs } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_MIN_SWIFT_BUILD_FREE_GIB = 80;

async function pathExists(filePath) {
	return !!(await stat(filePath).catch(() => null));
}

async function existingParent(dir) {
	let current = path.resolve(dir);
	while (!(await pathExists(current))) {
		const parent = path.dirname(current);
		if (parent === current) return parent;
		current = parent;
	}
	return current;
}

function gibToBytes(gib) {
	return gib * 1024 * 1024 * 1024;
}

export async function inspectFreeDiskSpace(
	targetDir,
	{ minFreeGiB = DEFAULT_MIN_SWIFT_BUILD_FREE_GIB } = {}
) {
	if (!Number.isFinite(minFreeGiB) || minFreeGiB < 0) {
		throw new Error('minFreeGiB must be a non-negative number');
	}
	const probePath = await existingParent(targetDir);
	const stats = await statfs(probePath);
	const freeBytes = Number(stats.bavail) * Number(stats.bsize);
	const requiredFreeBytes = gibToBytes(minFreeGiB);
	return {
		probePath,
		freeBytes,
		requiredFreeBytes,
		minFreeGiB,
		ok: freeBytes >= requiredFreeBytes
	};
}

export function formatGiB(bytes) {
	return (bytes / 1024 / 1024 / 1024).toFixed(1);
}
