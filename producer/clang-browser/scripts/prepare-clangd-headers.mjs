import fs from 'node:fs/promises';
import path from 'node:path';

function containsPath(parent, candidate) {
	const relative = path.relative(parent, candidate);
	return relative === '' || (
		!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
	);
}

async function resolveDestination(destination) {
	try {
		const stat = await fs.lstat(destination);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`clangd header destination must be a directory, not a symlink: ${destination}`);
		}
		return await fs.realpath(destination);
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
		return path.join(await resolveDestination(path.dirname(destination)), path.basename(destination));
	}
}

async function copyHeaders(source, destination, sysroot, ancestors = new Set()) {
	const resolved = await fs.realpath(source);
	if (!containsPath(sysroot, resolved)) {
		throw new Error(`clangd header symlink escapes the sysroot: ${source}`);
	}
	const stat = await fs.stat(resolved);
	if (stat.isDirectory()) {
		if (ancestors.has(resolved)) {
			throw new Error(`clangd header symlink creates a directory cycle: ${source}`);
		}
		const nextAncestors = new Set([...ancestors, resolved]);
		await fs.mkdir(destination, { recursive: true });
		for (const entry of await fs.readdir(resolved)) {
			await copyHeaders(
				path.join(resolved, entry), path.join(destination, entry), sysroot, nextAncestors
			);
		}
	} else if (stat.isFile()) {
		await fs.copyFile(resolved, destination);
	} else {
		throw new Error(`Unsupported clangd header file: ${source}`);
	}
}

// Keep this tree separate from the compiler sysroot, which is pruned more
// aggressively after clangd is built. Clangd must retain complete C/C++ headers.
export async function prepareClangdHeaders({ sysroot, destination, targetTriple }) {
	if (typeof targetTriple !== 'string' || !/^wasm32-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(targetTriple)) {
		throw new Error(`Invalid clangd header target triple: ${targetTriple}`);
	}
	if (typeof sysroot !== 'string' || !sysroot || typeof destination !== 'string' || !destination) {
		throw new Error('clangd header sysroot and destination paths are required');
	}
	const sourcePath = path.resolve(sysroot);
	const destinationPath = path.resolve(destination);
	if (containsPath(sourcePath, destinationPath) || containsPath(destinationPath, sourcePath)) {
		throw new Error('clangd header destination must be separate from the source sysroot');
	}
	const sourceRoot = await fs.realpath(sourcePath);
	const includeDir = await fs.realpath(path.join(sourceRoot, 'include'));
	if (!containsPath(sourceRoot, includeDir)) {
		throw new Error('clangd header include directory must be inside the sysroot');
	}
	const outputDir = await resolveDestination(destinationPath);
	if (containsPath(sourceRoot, outputDir) || containsPath(outputDir, sourceRoot)) {
		throw new Error('clangd header destination must be separate from the source sysroot');
	}
	const selectedDir = path.join(includeDir, targetTriple);
	if (!(await fs.stat(selectedDir).catch(() => null))?.isDirectory()) {
		throw new Error(`Required clangd header target directory is missing: ${targetTriple}`);
	}
	for (const relative of [path.join(targetTriple, 'stdio.h'), path.join('c++', 'v1', 'vector')]) {
		const header = path.join(includeDir, relative);
		const resolved = await fs.realpath(header).catch(() => null);
		if (!resolved || !containsPath(sourceRoot, resolved) || !(await fs.stat(resolved)).isFile()) {
			throw new Error(`Required clangd header is missing or outside the sysroot: ${relative}`);
		}
	}

	await fs.rm(outputDir, { recursive: true, force: true });
	await fs.mkdir(outputDir, { recursive: true });
	for (const entry of await fs.readdir(includeDir)) {
		if (entry.startsWith('wasm32-') && entry !== targetTriple) continue;
		await copyHeaders(path.join(includeDir, entry), path.join(outputDir, entry), sourceRoot);
	}
	return outputDir;
}
