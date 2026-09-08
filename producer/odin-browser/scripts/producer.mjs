#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const producerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(producerRoot, '../..');
const manifestPath = path.join(producerRoot, 'manifest.json');

export function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024, ...options
	});
	if (result.error) throw new Error(`${path.basename(command)}: ${result.error.message}`);
	if (result.signal) throw new Error(`${path.basename(command)} terminated by ${result.signal}`);
	return { exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function checked(command, args, options) {
	const result = run(command, args, options);
	if (result.exitCode !== 0) {
		throw new Error(`${path.basename(command)} exited ${result.exitCode}: ${result.stderr || result.stdout}`);
	}
	return result.stdout.trim();
}

export async function fileIdentity(file) {
	const info = await lstat(file);
	assert.ok(info.isFile() && !info.isSymbolicLink(), `not a regular file: ${file}`);
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	return { bytes: info.size, sha256: hash.digest('hex') };
}

export async function loadManifest() {
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.producerId, 'wasm-llvm/odin-browser');
	assert.match(manifest.source.commit, /^[a-f0-9]{40}$/);
	assert.equal(manifest.readiness.ready, false, 'this probe cannot establish browser readiness');
	assert.deepEqual(manifest.outputs, [], 'this producer has no browser compiler artifact yet');
	return manifest;
}

export async function verifySource(source, manifest = undefined) {
	manifest ??= await loadManifest();
	source = await realpath(source);
	assert.equal(checked('git', ['-C', source, 'rev-parse', '--show-toplevel']), source);
	assert.equal(checked('git', ['-C', source, 'rev-parse', 'HEAD']), manifest.source.commit,
		'Odin source commit does not match the lock');
	assert.equal(checked('git', ['-C', source, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching']), '',
		'Odin source must be clean, including ignored and untracked files');
	// Status alone trusts assume-unchanged/skip-worktree bits. Compare every source byte to HEAD.
	const tree = run('git', ['-C', source, 'ls-tree', '-rz', '--full-tree', 'HEAD']);
	assert.equal(tree.exitCode, 0, tree.stderr);
	for (const entry of tree.stdout.split('\0').filter(Boolean)) {
		const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s.exec(entry);
		assert.ok(match, 'source tree contains unsupported symlinks or gitlinks');
		const [, mode, expected, relative] = match;
		const file = path.join(source, relative);
		const info = await lstat(file);
		assert.ok(info.isFile() && !info.isSymbolicLink(), `source is not a regular file: ${relative}`);
		assert.equal((info.mode & 0o111) !== 0, mode === '100755', `source mode mismatch: ${relative}`);
		const hash = createHash('sha1').update(`blob ${info.size}\0`);
		for await (const chunk of createReadStream(file)) hash.update(chunk);
		assert.equal(hash.digest('hex'), expected, `source blob mismatch: ${relative}`);
	}
	for (const expected of manifest.source.files) {
		assert.equal((await fileIdentity(path.join(source, expected.path))).sha256, expected.sha256,
			`source hash mismatch: ${expected.path}`);
	}
	return { path: source, repository: manifest.source.repository, commit: manifest.source.commit };
}

async function producerIdentity() {
	const files = ['manifest.json'];
	async function collect(directory) {
		for (const entry of await readdir(path.join(producerRoot, directory), { withFileTypes: true })) {
			const relative = `${directory}/${entry.name}`;
			if (entry.isDirectory()) await collect(relative);
			else files.push(relative);
		}
	}
	await collect('scripts');
	await collect('fixtures');
	return Promise.all(files.sort().map(async (relative) => ({
		path: relative, ...await fileIdentity(path.join(producerRoot, relative))
	})));
}

export async function verifyNative(nativeRoot, manifest = undefined) {
	manifest ??= await loadManifest();
	assert.equal(`${process.platform}-${process.arch}`, manifest.nativeBootstrap.host,
		'the pinned native baseline compiler supports Linux x64 only');
	const executable = path.join(await realpath(nativeRoot), 'odin');
	const identity = await fileIdentity(executable);
	assert.equal(identity.sha256, manifest.nativeBootstrap.executableSha256, 'native Odin binary hash mismatch');
	const version = checked(executable, ['version']);
	assert.ok(version.endsWith(` version ${manifest.nativeBootstrap.version}`), 'native Odin version mismatch');
	return { path: executable, ...identity, version: manifest.nativeBootstrap.version,
		llvmVersion: manifest.nativeBootstrap.llvmVersion };
}

async function download(url, target, expected) {
	if (await lstat(target).catch(() => null)) {
		assert.deepEqual(await fileIdentity(target), expected, `cached download mismatch: ${target}`);
		return;
	}
	const temporary = `${target}.download-${randomUUID()}`;
	try {
		const response = await fetch(url);
		assert.ok(response.ok && response.body, `download failed with HTTP ${response.status}`);
		let bytes = 0;
		await pipeline(Readable.fromWeb(response.body), async function* (chunks) {
			for await (const chunk of chunks) {
				bytes += chunk.length;
				assert.ok(bytes <= expected.bytes, 'download exceeds locked size');
				yield chunk;
			}
		}, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
		assert.deepEqual(await fileIdentity(temporary), expected, 'download SHA-256/size mismatch');
		await rename(temporary, target);
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function prepare(work) {
	const manifest = await loadManifest();
	assert.equal(`${process.platform}-${process.arch}`, manifest.nativeBootstrap.host);
	await mkdir(work, { recursive: true });
	const source = path.join(work, 'source');
	if (!(await lstat(source).catch(() => null))) {
		checked('git', ['clone', '--depth', '1', '--branch', manifest.source.ref,
			manifest.source.repository, source], { timeout: 300_000 });
	}
	await verifySource(source, manifest);
	const pin = manifest.nativeBootstrap;
	const archive = path.join(work, pin.archive);
	await download(pin.url, archive, { bytes: pin.bytes, sha256: pin.sha256 });
	const nativeRoot = path.join(work, 'native', pin.root);
	if (!(await lstat(nativeRoot).catch(() => null))) {
		const temporary = path.join(work, `extract-${randomUUID()}`);
		await mkdir(temporary);
		try {
			// Extraction happens only after matching the immutable official archive digest.
			checked('tar', ['-xzf', archive, '--no-same-owner', '-C', temporary]);
			await verifyNative(path.join(temporary, pin.root), manifest);
			await mkdir(path.dirname(nativeRoot), { recursive: true });
			await rename(path.join(temporary, pin.root), nativeRoot);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}
	await verifyNative(nativeRoot, manifest);
	return { source, nativeRoot };
}

const WASI_FUNCTIONS = new Set([
	'args_get', 'args_sizes_get', 'fd_close', 'fd_filestat_get', 'fd_pread',
	'fd_prestat_dir_name', 'fd_prestat_get', 'fd_pwrite', 'fd_read', 'fd_seek',
	'fd_sync', 'fd_write', 'proc_exit', 'random_get'
]);

export async function inspectWasm(file) {
	const module = await WebAssembly.compile(await readFile(file));
	const imports = WebAssembly.Module.imports(module);
	const exports = WebAssembly.Module.exports(module);
	for (const entry of imports) {
		assert.ok(entry.module === 'wasi_snapshot_preview1' && entry.kind === 'function' && WASI_FUNCTIONS.has(entry.name),
			`unexpected Wasm import: ${entry.module}.${entry.name}`);
	}
	for (const name of ['fd_read', 'fd_write', 'proc_exit']) {
		assert.ok(imports.some((entry) => entry.name === name), `required WASI import missing: ${name}`);
	}
	assert.ok(exports.some((entry) => entry.name === '_start' && entry.kind === 'function'), 'missing _start');
	assert.ok(exports.some((entry) => entry.name === 'memory' && entry.kind === 'memory'), 'missing memory');
	return { imports, exports };
}

export async function nativeBaseline({ source, nativeRoot, wasmLd, output }) {
	const manifest = await loadManifest();
	const sourceIdentity = await verifySource(source, manifest);
	const odin = await verifyNative(nativeRoot, manifest);
	assert.ok(!path.resolve(output).startsWith(`${sourceIdentity.path}${path.sep}`), 'output must be outside the source checkout');
	// LLD selects the Wasm driver through argv[0]; preserve the wasm-ld symlink when invoking it.
	const linker = path.resolve(wasmLd);
	const linkerFile = await realpath(linker);
	const linkerVersion = checked(linker, ['--version']);
	assert.match(linkerVersion, /^LLD (?:17|18|19|20|21|22)\./, 'unsupported baseline linker version');
	const object = path.join(output, 'stdin-sum.o');
	const wasm = path.join(output, 'stdin-sum.wasm');
	assert.ok(!(await lstat(output).catch(() => null)), 'baseline output must not already exist');
	await mkdir(output, { recursive: true });
	const env = { ...process.env, ODIN_ROOT: sourceIdentity.path };
	const compile = ['build', path.join(producerRoot, 'fixtures/stdin-sum'), '-target:wasi_wasm32',
		'-build-mode:obj', `-out:${object}`, '-o:minimal', '-thread-count:1'];
	checked(odin.path, compile, { env });
	const objectBytes = await readFile(object);
	assert.ok(objectBytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])), 'compiler output is not Wasm');
	const objectModule = new WebAssembly.Module(objectBytes);
	assert.equal(WebAssembly.Module.customSections(objectModule, 'linking').length, 1, 'compiler output is not relocatable Wasm');
	const link = [object, '--stack-first', '-z', 'stack-size=1048576', '--allow-undefined', '-o', wasm];
	checked(linker, link);
	const wasmInfo = await inspectWasm(wasm);
	const cases = JSON.parse(await readFile(path.join(producerRoot, 'fixtures/cases.json'), 'utf8'));
	const results = [];
	for (const fixture of cases) {
		const result = run(process.execPath, ['--no-warnings', path.join(producerRoot, 'scripts/run-wasi-fixture.mjs'), wasm],
			{ input: fixture.stdin, timeout: 10_000 });
		assert.deepEqual(result, { exitCode: fixture.exitCode, stdout: fixture.stdout, stderr: fixture.stderr },
			`WASI fixture failed: ${fixture.name}`);
		results.push({ ...fixture, ...result });
	}
	const invalidObject = path.join(output, 'invalid.o');
	const diagnosticArgs = ['build', path.join(producerRoot, 'fixtures/invalid'), '-target:wasi_wasm32',
		'-build-mode:obj', `-out:${invalidObject}`, '-thread-count:1'];
	const diagnostics = run(odin.path, diagnosticArgs, { env });
	assert.ok(diagnostics.exitCode > 0, 'invalid program unexpectedly compiled');
	assert.match(diagnostics.stderr, /missing_symbol/);
	assert.ok(!(await lstat(invalidObject).catch(() => null)), 'invalid compilation left an output artifact');
	const receipt = {
		schemaVersion: 1, producerId: manifest.producerId, kind: 'native-wasi-baseline',
		status: 'passed', browserCompilerReady: false, source: sourceIdentity,
		producerFiles: await producerIdentity(),
		tools: { odin, wasmLd: { path: linkerFile, command: linker, ...await fileIdentity(linkerFile), version: linkerVersion },
			node: { path: await realpath(process.execPath), ...await fileIdentity(await realpath(process.execPath)), version: process.version } },
		commands: { compile, link, diagnostics: diagnosticArgs },
		outputs: await Promise.all(['stdin-sum.o', 'stdin-sum.wasm'].map(async (name) => ({
			path: name, ...await fileIdentity(path.join(output, name))
		}))),
		wasm: wasmInfo, cases: results, diagnostics
	};
	await writeFile(path.join(output, 'native-baseline-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
	return receipt;
}

export async function verifyBaseline(output) {
	const manifest = await loadManifest();
	const receipt = JSON.parse(await readFile(path.join(output, 'native-baseline-receipt.json'), 'utf8'));
	assert.equal(receipt.schemaVersion, 1);
	assert.equal(receipt.producerId, manifest.producerId);
	assert.equal(receipt.kind, 'native-wasi-baseline');
	assert.equal(receipt.status, 'passed');
	assert.equal(receipt.browserCompilerReady, false, 'a native baseline cannot establish browser readiness');
	assert.deepEqual(receipt.source, await verifySource(receipt.source.path, manifest));
	assert.deepEqual(receipt.producerFiles, await producerIdentity(), 'producer/fixture inputs changed');
	assert.deepEqual(receipt.tools.odin, await verifyNative(path.dirname(receipt.tools.odin.path), manifest));
	for (const tool of [receipt.tools.wasmLd, receipt.tools.node]) {
		assert.deepEqual(await fileIdentity(tool.path), { bytes: tool.bytes, sha256: tool.sha256 }, 'toolchain changed');
	}
	assert.equal(await realpath(receipt.tools.wasmLd.command), receipt.tools.wasmLd.path, 'linker command changed');
	assert.equal(checked(receipt.tools.wasmLd.command, ['--version']), receipt.tools.wasmLd.version);
	assert.deepEqual(receipt.outputs.map((entry) => entry.path), ['stdin-sum.o', 'stdin-sum.wasm']);
	for (const artifact of receipt.outputs) {
		assert.deepEqual(await fileIdentity(path.join(output, artifact.path)),
			{ bytes: artifact.bytes, sha256: artifact.sha256 }, `artifact hash mismatch: ${artifact.path}`);
	}
	assert.deepEqual(receipt.wasm, await inspectWasm(path.join(output, 'stdin-sum.wasm')));
	assert.deepEqual(receipt.cases, JSON.parse(await readFile(path.join(producerRoot, 'fixtures/cases.json'), 'utf8')));
	assert.ok(receipt.diagnostics.exitCode > 0);
	assert.match(receipt.diagnostics.stderr, /missing_symbol/);
	return receipt;
}

export async function probeHost({ source, emsdk, llvmInclude, output }) {
	const manifest = await loadManifest();
	const sourceIdentity = await verifySource(source, manifest);
	assert.ok(!path.resolve(output).startsWith(`${sourceIdentity.path}${path.sep}`), 'output must be outside the source checkout');
	assert.ok(!(await lstat(output).catch(() => null)), 'host probe output must not already exist');
	emsdk = await realpath(emsdk);
	assert.equal(checked('git', ['-C', emsdk, 'rev-parse', 'HEAD']), manifest.hostProbe.emscripten.commit,
		'Emscripten SDK checkout does not match the lock');
	const header = path.join(llvmInclude, 'llvm/Config/llvm-config.h');
	assert.equal((await fileIdentity(header)).sha256, manifest.hostProbe.llvmHeaders.configSha256,
		'LLVM generated header mismatch');
	await fileIdentity(path.join(llvmInclude, 'llvm-c/Types.h'));
	const empp = path.join(emsdk, 'upstream/emscripten/em++');
	const env = { ...process.env, EM_CONFIG: path.join(emsdk, '.emscripten'), EM_CACHE: path.join(output, 'cache') };
	const version = checked(empp, ['--version'], { env });
	assert.match(version, /^emcc .* 6\.0\.0\b/, 'Emscripten compiler version mismatch');
	await mkdir(output, { recursive: true });
	const args = ['-std=c++14', '-fsyntax-only', '-ferror-limit=8', '-Wno-macro-redefined', '-Wno-switch',
		'-Wno-unused-value', `-I${llvmInclude}`, path.join(sourceIdentity.path, 'src/main.cpp')];
	const result = run(empp, args, { env });
	const receipt = {
		schemaVersion: 1, producerId: manifest.producerId, kind: 'upstream-main-cxx-syntax',
		status: result.exitCode === 0 ? 'syntax-passed' : 'blocked', browserCompilerReady: false,
		compilerHost: manifest.compilerHost, source: sourceIdentity, producerFiles: await producerIdentity(),
		toolchain: { emsdkCommit: manifest.hostProbe.emscripten.commit, version,
			empp: { path: empp, ...await fileIdentity(empp) },
			llvmHeader: { path: header, ...await fileIdentity(header) }, llvmVersion: manifest.hostProbe.llvmHeaders.version },
		command: { executable: empp, args }, result
	};
	await writeFile(path.join(output, 'host-probe-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
	return receipt;
}

export function parseArgs(argv) {
	const [command, ...raw] = argv;
	const rest = raw[0] === '--' ? raw.slice(1) : raw;
	assert.ok(['prepare', 'verify-source', 'baseline', 'verify-baseline', 'probe-host'].includes(command),
		'Usage: producer.mjs prepare|verify-source|baseline|verify-baseline|probe-host [--work DIR] [--source DIR] [--native-root DIR] [--wasm-ld FILE] [--output DIR] [--emsdk DIR] [--llvm-include DIR]');
	const allowed = {
		prepare: ['work'], 'verify-source': ['source'],
		baseline: ['source', 'native-root', 'wasm-ld', 'output'], 'verify-baseline': ['output'],
		'probe-host': ['source', 'emsdk', 'llvm-include', 'output']
	}[command];
	const options = {};
	for (let index = 0; index < rest.length; index += 2) {
		const key = rest[index].replace(/^--/, '');
		assert.ok(rest[index].startsWith('--') && allowed.includes(key), `unknown option: ${rest[index]}`);
		assert.ok(rest[index + 1] && !rest[index + 1].startsWith('--'), `missing value: ${rest[index]}`);
		assert.ok(!(key in options), `duplicate option: ${rest[index]}`);
		options[key] = path.resolve(rest[index + 1]);
	}
	for (const key of allowed) assert.ok(options[key], `missing option: --${key}`);
	return { command, options };
}

async function main() {
	const { command, options } = parseArgs(process.argv.slice(2));
	let result;
	if (command === 'prepare') result = await prepare(options.work);
	if (command === 'verify-source') result = await verifySource(options.source);
	if (command === 'baseline') result = await nativeBaseline({ source: options.source,
		nativeRoot: options['native-root'], wasmLd: options['wasm-ld'], output: options.output });
	if (command === 'verify-baseline') result = await verifyBaseline(options.output);
	if (command === 'probe-host') {
		result = await probeHost({ source: options.source, emsdk: options.emsdk,
			llvmInclude: options['llvm-include'], output: options.output });
		process.exitCode = result.result.exitCode === 0 ? 0 : 1;
	}
	console.log(JSON.stringify({ command, status: result.status ?? 'verified',
		browserCompilerReady: false, output: options.output, ...(command === 'prepare' ? result : {}) }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
