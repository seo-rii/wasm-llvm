#!/usr/bin/env node
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	PRODUCER_ROOT, OUTPUT_NAMES, exists, sha256, readJson, writeJson, inputHashes,
	validateLock, outputDirectory, run, assertInputsMatch, sourceTreeHash, assertSourceTree, assertValidation
} from './shared.mjs';

const PATCH = 'patches/source-archive-and-bridge.patch';

async function download(item, cache) {
	const file = path.join(cache, item.archive);
	if (!await exists(file)) {
		const partial = `${file}.partial`;
		await run('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '3', '--output', partial, item.url]);
		if ((await stat(partial)).size !== item.size || await sha256(partial) !== item.sha256) {
			await rm(partial, { force: true });
			throw new Error(`Downloaded archive differs from source lock: ${item.archive}`);
		}
		await copyFile(partial, file);
		await rm(partial);
	}
	if ((await stat(file)).size !== item.size || await sha256(file) !== item.sha256) {
		throw new Error(`Cached archive differs from source lock: ${item.archive}`);
	}
	return file;
}

async function extractConda(archive, prefix, cache) {
	// The archive was checked against its immutable package hash before extraction.
	const members = await run('python3', ['-c',
		'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); n=next(n for n in z.namelist() if n.startswith("pkg-") and n.endswith(".tar.zst")); assert "/" not in n; z.extract(n,sys.argv[2]); print(n)',
		archive, cache], { capture: true });
	await run('tar', ['--zstd', '-xf', path.join(cache, members), '-C', prefix]);
}

function buildEnvironment(out, lock) {
	return {
		...process.env,
		PATH: `${path.join(out, 'native/bin')}:${path.join(out, 'emsdk/upstream/emscripten')}:${process.env.PATH}`,
		BISON_PKGDATADIR: path.join(out, 'native/share/bison'),
		LFORTRAN_SOURCE_VERSION: lock.source.version,
		EM_CONFIG: path.join(out, 'emsdk/.emscripten'),
		EM_CACHE: path.join(out, 'em-cache'),
		EMSDK: path.join(out, 'emsdk'),
		EMSDK_KEEP_DOWNLOADS: '1',
		EMSDK_NUM_CORES: '2',
		CMAKE_BUILD_PARALLEL_LEVEL: '2'
	};
}

export async function prepare(out) {
	if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This producer locks Linux x86_64 build helpers');
	const lock = validateLock(await readJson(path.join(PRODUCER_ROOT, 'sources.lock.json')));
	const cache = path.join(out, 'cache');
	for (const dir of ['cache', 'native', 'llvm', 'emsdk']) await mkdir(path.join(out, dir), { recursive: true });
	for (const item of [lock.source, lock.emsdk, ...lock.packages, ...lock.sdkArchives]) await download(item, cache);
	const identity = { source: lock.source.sha256, patch: await sha256(path.join(PRODUCER_ROOT, PATCH)), patchTool: 'patch-fuzz0', treeSchemaVersion: 1 };
	const marker = path.join(out, 'source-identity.json');
	let cached = await exists(marker) ? await readJson(marker) : null;
	if (!cached || JSON.stringify(cached.identity) !== JSON.stringify(identity) || !await exists(path.join(out, 'source'))) {
		await rm(path.join(out, 'source'), { force: true, recursive: true });
		await mkdir(path.join(out, 'source'));
		await run('tar', ['-xzf', path.join(cache, lock.source.archive), '-C', path.join(out, 'source'), '--strip-components=1']);
		await run('patch', ['--dry-run', '--batch', '--fuzz=0', '-p1', '-i', path.join(PRODUCER_ROOT, PATCH)], { cwd: path.join(out, 'source') });
		await run('patch', ['--batch', '--fuzz=0', '-p1', '-i', path.join(PRODUCER_ROOT, PATCH)], { cwd: path.join(out, 'source') });
		cached = { identity, bootstrapReady: false };
	} else await assertSourceTree(path.join(out, 'source'), cached);
	await cp(path.join(PRODUCER_ROOT, 'src'), path.join(out, 'source/producer-bridge'), { recursive: true });
	cached.treeSha256 = await sourceTreeHash(path.join(out, 'source'));
	await writeJson(marker, cached);
	if (!await exists(path.join(out, 'emsdk/emsdk'))) {
		await run('tar', ['-xzf', path.join(cache, lock.emsdk.archive), '-C', path.join(out, 'emsdk'), '--strip-components=1']);
	}
	const previous = await exists(path.join(out, 'prepare-receipt.json')) ? await readJson(path.join(out, 'prepare-receipt.json')) : null;
	for (const item of lock.packages) {
		const prefix = path.join(out, item.name === 'llvm' ? 'llvm' : 'native');
		const probe = path.join(prefix, item.name === 'llvm' ? 'lib/cmake/llvm/LLVMConfig.cmake' : `bin/${item.name}`);
		if (previous?.packages?.some((old) => old.name === item.name && old.sha256 === item.sha256) && await exists(probe)) continue;
		if (item.archive.endsWith('.conda')) await extractConda(path.join(cache, item.archive), prefix, cache);
		else await run('tar', ['-xjf', path.join(cache, item.archive), '-C', prefix]);
	}
	const env = buildEnvironment(out, lock);
	await mkdir(path.join(out, 'emsdk/downloads'), { recursive: true });
	for (const item of lock.sdkArchives) {
		await copyFile(path.join(cache, item.archive), path.join(out, 'emsdk/downloads', item.sdkFilename));
	}
	await run(path.join(out, 'emsdk/emsdk'), ['install', lock.emsdk.version], { env });
	await run(path.join(out, 'emsdk/emsdk'), ['activate', lock.emsdk.version], { env });
	const releases = await readJson(path.join(out, 'emsdk/emscripten-releases-tags.json'));
	if (releases.releases[lock.emsdk.version] !== lock.emsdk.release) throw new Error('Emscripten release identity changed');
	await writeJson(path.join(out, 'prepare-receipt.json'), { schemaVersion: 1, source: lock.source, emsdk: lock.emsdk, packages: lock.packages, sdkArchives: lock.sdkArchives, identity });
	return { lock, env };
}

export async function build(out, jobs = 2) {
	if (![1, 2].includes(jobs)) throw new Error('Build jobs must be 1 or 2');
	const inputs = await inputHashes();
	const { lock, env } = await prepare(out);
	const source = path.join(out, 'source');
	const native = path.join(out, 'build-native');
	const browser = path.join(out, 'build-browser');
	const mods = path.join(out, 'modules');
	await mkdir(mods, { recursive: true });
	const marker = path.join(out, 'source-identity.json');
	const sourceIdentity = await readJson(marker);
	if (!sourceIdentity.bootstrapReady) {
		try {
			await run('bash', ['build0.sh'], { cwd: source, env });
			sourceIdentity.bootstrapReady = true;
		} finally {
			sourceIdentity.treeSha256 = await sourceTreeHash(source);
			await writeJson(marker, sourceIdentity);
		}
	}
	const common = ['-G', 'Ninja', '-DLFORTRAN_BUILD_ALL=no', '-DWITH_RUNTIME_LIBRARY=no',
		'-DWITH_STACKTRACE=no', '-DWITH_RUNTIME_STACKTRACE=no', '-DWITH_XEUS=no',
		'-DWITH_LSP=no', '-DWITH_KOKKOS=no', '-DWITH_WHEREAMI=no', '-DWITH_ZLIB=no', '-DWITH_ZSTD=no'];
	await run('cmake', ['-S', source, '-B', native, ...common, '-DCMAKE_BUILD_TYPE=Release',
		'-DCMAKE_CXX_FLAGS_RELEASE=-O0 -DNDEBUG', '-DCMAKE_C_FLAGS_RELEASE=-O0 -DNDEBUG', '-DWITH_LLVM=no'], { env });
	await run('cmake', ['--build', native, '--target', 'lfortran', '--parallel', String(jobs)], { env });
	for (const file of ['pure/lfortran_intrinsic_iso_fortran_env.f90', 'custom/lfortran_intrinsic_custom.f90',
		'pure/lfortran_intrinsic_ieee_arithmetic.f90', 'pure/lfortran_intrinsic_iso_c_binding.f90',
		'openmp/omp_lib.f90', 'impure/lfortran_display.f90']) {
		await run(path.join(native, 'src/bin/lfortran'), ['--backend=cpp', '-c', '-J', mods, '-I', mods, path.join(source, 'src/runtime', file)], { cwd: mods, env });
	}
	await run(path.join(out, 'emsdk/upstream/emscripten/emcmake'), ['cmake', '-S', source, '-B', browser,
		...common, '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_CXX_FLAGS=-fwasm-exceptions',
		'-DCMAKE_CXX_FLAGS_RELEASE=-O1 -DNDEBUG', '-DCMAKE_C_FLAGS=-fwasm-exceptions',
		'-DWITH_LLVM=yes', '-DLFORTRAN_BROWSER_BRIDGE=yes',
		`-DLFORTRAN_BROWSER_MOD_DIR=${mods}`, `-DLLVM_DIR=${path.join(out, 'llvm/lib/cmake/llvm')}`,
		`-DLLD_DIR=${path.join(out, 'llvm/lib/cmake/lld')}`, `-DCMAKE_FIND_ROOT_PATH=${path.join(out, 'llvm')}`,
		`-DCMAKE_PREFIX_PATH=${path.join(out, 'llvm')}`], { env });
	await run('cmake', ['--build', browser, '--target', 'lfortran-browser', '--parallel', String(jobs)], { env });
	const files = {};
	for (const name of OUTPUT_NAMES) {
		const file = path.join(browser, 'producer-bridge', name);
		files[name] = { sha256: await sha256(file), size: (await stat(file)).size };
	}
	const versions = {};
	for (const [name, command, args] of [
		['emcc', path.join(out, 'emsdk/upstream/emscripten/emcc'), ['--version']],
		['nativeCxx', 'c++', ['--version']], ['cmake', 'cmake', ['--version']],
		['bison', path.join(out, 'native/bin/bison'), ['--version']],
		['re2c', path.join(out, 'native/bin/re2c'), ['--version']]
	]) versions[name] = (await run(command, args, { env, capture: true })).split('\n')[0];
	if (JSON.stringify(inputs) !== JSON.stringify(await inputHashes())) throw new Error('Producer inputs changed while building; rerun the build');
	await assertSourceTree(source, sourceIdentity);
	await writeJson(path.join(out, 'build-receipt.json'), {
		schemaVersion: 1, producerId: 'wasm-llvm/lfortran-browser',
		inputs, files, versions, source: lock.source.commit, sourceTreeSha256: sourceIdentity.treeSha256,
		backend: 'llvm', host: 'emscripten', execution: 'dynamic-side-module',
		validation: { passed: false }, createdAt: new Date().toISOString()
	});
}

export async function packageArtifacts(out) {
	const receipt = await readJson(path.join(out, 'build-receipt.json'));
	await assertInputsMatch(receipt);
	const destination = path.join(out, 'artifacts');
	await mkdir(destination, { recursive: true });
	for (const name of OUTPUT_NAMES) {
		const file = path.join(out, 'build-browser/producer-bridge', name);
		if (await sha256(file) !== receipt.files[name]?.sha256) throw new Error(`Build artifact changed: ${name}`);
		await copyFile(file, path.join(destination, name));
	}
	await writeJson(path.join(destination, 'producer-receipt.json'), receipt);
	await verifyArtifacts(destination, false);
	return destination;
}

export async function verifyArtifacts(directory, requireValidation = true) {
	const receipt = await readJson(path.join(directory, 'producer-receipt.json'));
	await assertInputsMatch(receipt);
	if (receipt.backend !== 'llvm' || receipt.host !== 'emscripten' || receipt.execution !== 'dynamic-side-module') {
		throw new Error('Artifact is not the upstream LLVM-enabled Emscripten compiler');
	}
	const expected = [...OUTPUT_NAMES, 'producer-receipt.json'].sort();
	if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expected)) throw new Error('Unexpected artifact closure');
	for (const name of OUTPUT_NAMES) {
		const file = path.join(directory, name);
		if ((await stat(file)).size !== receipt.files[name]?.size || await sha256(file) !== receipt.files[name]?.sha256) {
			throw new Error(`Artifact hash or size mismatch: ${name}`);
		}
	}
	await WebAssembly.compile(await readFile(path.join(directory, 'lfortran.wasm')));
	if (requireValidation) assertValidation(receipt);
	return receipt;
}

async function main() {
	const [command = 'help', ...args] = process.argv.slice(2);
	const flags = {};
	for (let i = 0; i < args.length; i += 2) {
		if (!['--out', '--jobs', '--artifacts'].includes(args[i]) || !args[i + 1]) throw new Error('Invalid command arguments');
		flags[args[i]] = args[i + 1];
	}
	if (command === 'help') {
		console.log('producer.mjs prepare|build|package|verify [--out <repo/out/task>] [--jobs 1|2] [--artifacts <directory>]');
		return;
	}
	const out = outputDirectory(flags['--out']);
	if (command === 'prepare') await prepare(out);
	else if (command === 'build') await build(out, Number(flags['--jobs'] ?? 2));
	else if (command === 'package') console.log(await packageArtifacts(out));
	else if (command === 'verify') await verifyArtifacts(path.resolve(flags['--artifacts'] ?? path.join(out, 'artifacts')));
	else throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
