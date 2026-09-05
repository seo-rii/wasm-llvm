#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readlink, writeFile, rename, rm, stat, readdir, copyFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const producerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(producerRoot, '../..');
const manifestPath = path.join(producerRoot, 'manifest.json');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const readManifest = async () => JSON.parse(await readFile(manifestPath, 'utf8'));

export async function treeHash(directory) {
	const entries = [];
	async function visit(current, relative = '') {
		for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name === '.git') continue;
			const filename = path.join(current, entry.name);
			const name = `${relative}${entry.name}`;
			if (entry.isDirectory()) await visit(filename, `${name}/`);
			else if (entry.isFile()) entries.push([name, sha256(await readFile(filename))]);
			else if (entry.isSymbolicLink()) {
				const target = await readlink(filename);
				const resolved = path.resolve(path.dirname(filename), target);
				if (!resolved.startsWith(`${path.resolve(directory)}${path.sep}`)) throw new Error(`Symlink escapes prepared tree: ${filename}`);
				entries.push([name, 'symlink', target]);
			}
			else throw new Error(`Unexpected non-regular source file: ${filename}`);
		}
	}
	await visit(directory);
	return sha256(JSON.stringify(entries));
}

export function paths(workDir = process.env.WASM_LLVM_C3_WORK_DIR) {
	const work = path.resolve(workDir || path.join(repoRoot, 'out/c3-browser-work'));
	return {
		work,
		cache: path.join(work, 'cache'),
		source: path.join(work, 'source'),
		sdk: path.join(work, 'emsdk'),
		llvm: path.join(work, 'llvm'),
		build: path.join(work, 'build'),
		release: path.resolve(process.env.WASM_LLVM_C3_OUT_DIR || path.join(repoRoot, 'out/c3-browser'))
	};
}

export function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const { capture = false, ...spawnOptions } = options;
		const child = spawn(command, args, {
			stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
			...spawnOptions
		});
		let output = '';
		if (capture) {
			for (const stream of [child.stdout, child.stderr]) {
				stream.on('data', (chunk) => {
					output += chunk;
				});
			}
		}
		child.once('error', reject);
		child.once('close', (code, signal) => {
			if (code === 0) resolve(output.trim());
			else reject(new Error(`${path.basename(command)} failed (${signal || code})${output ? `: ${output.slice(-8000)}` : ''}`));
		});
	});
}

export function assertReceipt(bytes, expected, label) {
	if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) {
		throw new Error(`${label} does not match its pinned size and SHA-256`);
	}
}

async function downloadPinned(url, destination, receipt) {
	if (await stat(destination).catch(() => null)) {
		assertReceipt(await readFile(destination), receipt, path.basename(destination));
		return;
	}
	const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
	if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	assertReceipt(bytes, receipt, url);
	await writeFile(`${destination}.tmp`, bytes, { mode: 0o600 });
	await rename(`${destination}.tmp`, destination);
}

export async function assertCleanCheckout(directory, { sdkGeneratedFiles = false } = {}) {
	const indexEntries = await run('git', ['-C', directory, 'ls-files', '-v', '-z'], { capture: true });
	if (indexEntries.split('\0').filter(Boolean).some((entry) => !entry.startsWith('H '))) {
		throw new Error(`Hidden or unresolved index flags in pinned source checkout: ${directory}`);
	}
	await run('git', ['-C', directory, 'diff', '--exit-code'], { capture: true });
	await run('git', ['-C', directory, 'diff', '--cached', '--exit-code'], { capture: true });
	// Deliberately omit --exclude-standard: ignored C3 files can still affect its build.
	const untracked = await run('git', ['-C', directory, 'ls-files', '--others', '-z'], { capture: true });
	const generated = new Set(sdkGeneratedFiles ? [
		'upstream', 'node', 'downloads', '.emscripten', '.emscripten.old',
		'.emscripten_cache', '.emscripten_cache__last_clear', '.emscripten_sanity', '.emscripten_sanity_wasm'
	] : []);
	if (untracked.split('\0').filter(Boolean).some((name) => !generated.has(name.split('/')[0]))) {
		throw new Error(`Unexpected untracked or ignored files in pinned source checkout: ${directory}`);
	}
}

async function checkout(pin, directory, patches = [], options = {}) {
	if (!(await stat(path.join(directory, '.git')).catch(() => null))) {
		await mkdir(directory, { recursive: true });
		await run('git', ['init', directory]);
		await run('git', ['-C', directory, 'remote', 'add', 'origin', pin.repository]);
		await run('git', ['-C', directory, 'fetch', '--depth=1', 'origin', pin.commit]);
		await run('git', ['-C', directory, 'checkout', '--detach', 'FETCH_HEAD']);
	}
	const head = await run('git', ['-C', directory, 'rev-parse', 'HEAD'], { capture: true });
	if (head !== pin.commit) throw new Error(`Source checkout mismatch at ${directory}`);
	const patchPaths = [];
	for (const patch of patches) {
		const filename = path.join(producerRoot, patch.path);
		if (sha256(await readFile(filename)) !== patch.sha256) throw new Error(`Patch checksum mismatch: ${patch.path}`);
		patchPaths.push(filename);
	}
	for (const filename of [...patchPaths].reverse()) {
		const applied = await run('git', ['-C', directory, 'apply', '--reverse', '--check', filename], { capture: true }).then(() => true, () => false);
		if (applied) await run('git', ['-C', directory, 'apply', '--reverse', filename]);
	}
	await assertCleanCheckout(directory, options);
	for (const filename of patchPaths) await run('git', ['-C', directory, 'apply', filename]);
}

async function sdkEnvironment(p) {
	const variables = await run('bash', ['-c', 'source "$1" >/dev/null 2>&1 && env -0', 'c3-sdk', path.join(p.sdk, 'emsdk_env.sh')], { capture: true });
	return Object.fromEntries(variables.split('\0').filter(Boolean).map((entry) => {
		const index = entry.indexOf('=');
		return [entry.slice(0, index), entry.slice(index + 1)];
	}));
}

export async function prepare(p = paths()) {
	const manifest = await readManifest();
	await mkdir(p.cache, { recursive: true });
	await checkout(manifest.sources.c3, p.source, manifest.patches);
	await checkout(manifest.sources.emsdk, p.sdk, [], { sdkGeneratedFiles: true });
	const archive = path.join(p.cache, 'llvm-wasm32-emscripten.tar.xz');
	await downloadPinned(manifest.llvm.url, archive, manifest.llvm);
	const extracted = await mkdtemp(path.join(p.work, 'llvm-next-'));
	try {
		await run('tar', ['-xJf', archive, '-C', extracted]);
		await treeHash(extracted);
		await rm(p.llvm, { recursive: true, force: true });
		await rename(extracted, p.llvm);
	} finally {
		await rm(extracted, { recursive: true, force: true });
	}
	await run(path.join(p.sdk, 'emsdk'), ['install', manifest.sources.emsdk.version], { cwd: p.sdk });
	await run(path.join(p.sdk, 'emsdk'), ['activate', manifest.sources.emsdk.version], { cwd: p.sdk });
	await writeFile(path.join(p.work, 'prepared.json'), `${JSON.stringify({
		manifestSha256: sha256(await readFile(manifestPath)),
		sourceTreeSha256: await treeHash(p.source),
		llvmTreeSha256: await treeHash(p.llvm)
	}, null, 2)}\n`);
	console.log(`Prepared C3 ${manifest.sources.c3.version} in ${p.work}`);
}

export async function build(p = paths()) {
	const manifest = await readManifest();
	const builderSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
	const prepared = JSON.parse(await readFile(path.join(p.work, 'prepared.json'), 'utf8'));
	if (prepared.manifestSha256 !== sha256(await readFile(manifestPath))) throw new Error('Manifest changed; run prepare again');
	if (prepared.sourceTreeSha256 !== await treeHash(p.source)) throw new Error('Prepared C3 source tree changed');
	if (prepared.llvmTreeSha256 !== await treeHash(p.llvm)) throw new Error('Prepared LLVM library tree changed');
	await checkout(manifest.sources.emsdk, p.sdk, [], { sdkGeneratedFiles: true });
	assertReceipt(await readFile(path.join(p.cache, 'llvm-wasm32-emscripten.tar.xz')), manifest.llvm, 'LLVM archive');
	const env = { ...await sdkEnvironment(p), EMCC_CORES: '2', BINARYEN_CORES: '2' };
	const emcc = path.join(p.sdk, 'upstream/emscripten/emcc');
	const sdkVersion = await run(emcc, ['--version'], { env, capture: true });
	if (!sdkVersion.includes(` ${manifest.sources.emsdk.version} `)) throw new Error(`Unexpected Emscripten compiler: ${sdkVersion.split('\n')[0]}`);
	const linkerFlags = [
		'-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=web,worker,node',
		'-sEXPORTED_RUNTIME_METHODS=FS,callMain', '-sINVOKE_RUN=0', '-sEXIT_RUNTIME=1',
		'-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=134217728', '-sMAXIMUM_MEMORY=2147483648',
		'-sSTACK_SIZE=8388608', '-sASSERTIONS=1',
		`--embed-file=${p.source}/lib@/lib`
	].join(' ');
	await run(path.join(p.sdk, 'upstream/emscripten/emcmake'), [
		'cmake', '-S', p.source, '-B', p.build, '-G', 'Ninja',
		'-DCMAKE_BUILD_TYPE=Release', '-DC3_FETCH_LLVM=OFF', '-DC3_WITH_LLVM=ON',
		`-DCMAKE_FIND_ROOT_PATH=${p.llvm}`,
		'-DC3_AVR_DISABLE=ON', `-DLLVM_DIR=${p.llvm}/lib/cmake/llvm`,
		`-DLLD_DIR=${p.llvm}/lib/cmake/lld`, `-DC3_LLD_INCLUDE_DIR=${p.llvm}/include`,
		`-DCMAKE_EXE_LINKER_FLAGS=${linkerFlags}`
	], { env });
	await run('cmake', ['--build', p.build, '--target', 'c3c', '--parallel', '2'], { env });
	await copyFile(path.join(p.build, 'c3c.js'), path.join(p.build, 'c3c.mjs'));
	await writeFile(path.join(p.build, 'build-receipt.json'), `${JSON.stringify({
		manifestSha256: sha256(await readFile(manifestPath)),
		builderSha256,
		prepared,
		sdkVersion,
		linkerFlags,
		assets: Object.fromEntries(await Promise.all(['c3c.mjs', 'c3c.wasm'].map(async (name) => {
			const bytes = await readFile(path.join(p.build, name));
			return [name, { bytes: bytes.length, sha256: sha256(bytes) }];
		})))
	}, null, 2)}\n`);
	console.log(`Built C3 compiler at ${p.build}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [command, ...extra] = process.argv.slice(2);
	if (extra.length || !['prepare', 'build'].includes(command)) throw new Error('Usage: producer.mjs prepare|build');
	await ({ prepare, build })[command]();
}
