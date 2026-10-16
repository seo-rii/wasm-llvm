#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { replaceArtifactDirectory } from '../../../scripts/lib/artifact-directory.mjs';
import { COBOL_ASSETS, loadVerifiedCobolArtifacts, verifyCobolArtifactBytes } from './verify-artifacts.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export async function prepareCobolRelease(sourceDir, targetDir) {
	const source = await fs.realpath(sourceDir);
	const target = await fs.realpath(targetDir).catch((error) => {
		if (error.code === 'ENOENT') return path.resolve(targetDir);
		throw error;
	});
	const sourceRelativeToTarget = path.relative(target, source);
	if (!path.isAbsolute(sourceRelativeToTarget) &&
		sourceRelativeToTarget !== '..' && !sourceRelativeToTarget.startsWith(`..${path.sep}`)) {
		throw new Error('COBOL release output must not replace its source directory or an ancestor');
	}
	const { receipt: toolchain, assetBytes } = await loadVerifiedCobolArtifacts(sourceDir);
	const buildAssets = COBOL_ASSETS.map((asset) => {
		const bytes = assetBytes.get(asset);
		return { asset, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
	});
	const profile = {
		name: 'gnucobol-wasi-clang',
		version: 1,
		gnucobolVersion: toolchain.gnucobolVersion,
		gmpVersion: toolchain.gmpVersion,
		frontendTarget: 'wasm32-wasi',
		backend: 'wasm-llvm-clang',
		unsupported: ['dynamic CALL', 'CALL SYSTEM', 'fork', 'SCREEN SECTION', 'indexed I/O']
	};
	const manifest = {
		manifestVersion: 1,
		version: toolchain.version,
		frontend: { asset: 'cobc.zip', argv0: 'cobc' },
		rootfs: { asset: 'rootfs.tar.zip' },
		cSysroot: { asset: 'c-sysroot.tar.zip' },
		profile
	};
	const files = new Map(assetBytes);
	files.set('runtime-manifest.v1.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
	files.set('runtime-build.json', Buffer.from(JSON.stringify({ toolchain, assets: buildAssets }, null, 2) + '\n'));
	await replaceArtifactDirectory(targetDir, async (staged) => {
		for (const [name, bytes] of files) await fs.writeFile(path.join(staged, name), bytes);
		const stagedFiles = new Map(await Promise.all([...files.keys()].map(async (name) => [
			name, await fs.readFile(path.join(staged, name))
		])));
		for (const [name, expected] of files) {
			if (!stagedFiles.get(name).equals(expected)) throw new Error(`Staged COBOL release differs: ${name}`);
		}
		await verifyCobolArtifactBytes(toolchain, stagedFiles);
	});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const sourceDir = path.resolve(process.env.WASM_LLVM_COBOL_ARTIFACT_DIR ||
		path.join(REPO_ROOT, 'artifacts', 'cobol-browser'));
	const targetDir = path.resolve(process.env.WASM_LLVM_COBOL_RELEASE_DIR || process.argv[2] ||
		path.join(REPO_ROOT, 'out', 'cobol-browser'));
	await prepareCobolRelease(sourceDir, targetDir);
	console.log(`Prepared the COBOL deployment bundle in ${targetDir}`);
}
