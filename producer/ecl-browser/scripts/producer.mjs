#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, cp, mkdir, readdir, readFile, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const producerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(producerRoot, '../..');
const manifestPath = path.join(producerRoot, 'manifest.json');
export const runtimeAssets = ['ecl.mjs', 'ecl.wasm'];
// ecl.wasm ships gzip-compressed (level 9); its logical bytes stay bound by the receipt.
export const deliveryName = 'ecl.wasm.gz';
export const releaseFiles = ['ecl.mjs', deliveryName, 'producer-receipt.json'];
export const fixtureNames = ['stdin.lisp', 'error.lisp', 'gc.lisp', 'recursion.lisp'];
export const acceptanceInputs = [
	...fixtureNames.map((name) => `fixtures/${name}`),
	'scripts/harness.mjs',
	'scripts/browser-worker.mjs',
	'scripts/producer.mjs'
];
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const receiptFor = (bytes) => ({ bytes: bytes.length, sha256: sha256(bytes) });
export const readManifest = async () => JSON.parse(await readFile(manifestPath, 'utf8'));
const sdkGeneratedPaths = [
	'upstream', 'node', 'downloads', '.emscripten', '.emscripten.old',
	'.emscripten_cache', '.emscripten_cache__last_clear', '.emscripten_sanity', '.emscripten_sanity_wasm'
];

export function paths(workDir = process.env.WASM_LLVM_ECL_WORK_DIR) {
	const work = path.resolve(workDir || path.join(repoRoot, 'out/ecl-browser-work'));
	return {
		work,
		source: path.join(work, 'ecl'),
		sdk: path.resolve(process.env.WASM_LLVM_ECL_EMSDK || path.join(work, 'emsdk')),
		hostBuild: path.join(work, 'host-build'),
		host: path.join(work, 'host'),
		crossBuild: path.join(work, 'cross-build'),
		build: path.join(work, 'build'),
		release: path.resolve(process.env.WASM_LLVM_ECL_OUT_DIR || path.join(repoRoot, 'out/ecl-browser')),
		artifacts: path.join(repoRoot, 'artifacts/ecl-browser')
	};
}

const jobs = () => {
	const value = Number(process.env.WASM_LLVM_ECL_JOBS || 3);
	if (!Number.isSafeInteger(value) || value < 1 || value > 3) throw new Error('WASM_LLVM_ECL_JOBS must be 1, 2, or 3');
	return String(value);
};

export function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const { capture = false, ...spawnOptions } = options;
		const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', ...spawnOptions });
		let output = '';
		if (capture) for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; });
		child.once('error', reject);
		child.once('close', (code, signal) => {
			if (code === 0) resolve(output.trim());
			else reject(new Error(`${path.basename(command)} failed (${signal || code})${output ? `: ${output.slice(-8000)}` : ''}`));
		});
	});
}

export function assertReceipt(bytes, expected, label) {
	if (bytes.length !== expected?.bytes || sha256(bytes) !== expected?.sha256) {
		throw new Error(`${label} does not match its pinned size and SHA-256`);
	}
}

export async function treeHash(directory) {
	const entries = [];
	async function visit(current, relative = '') {
		for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name === '.git') continue;
			const filename = path.join(current, entry.name);
			const name = `${relative}${entry.name}`;
			if (entry.isDirectory()) await visit(filename, `${name}/`);
			else if (entry.isFile()) entries.push([name, sha256(await readFile(filename))]);
			else if (entry.isSymbolicLink()) entries.push([name, 'symlink', await readlink(filename)]);
			else throw new Error(`Unexpected non-regular source file: ${filename}`);
		}
	}
	await visit(directory);
	return sha256(JSON.stringify(entries));
}

export async function assertCleanCheckout(directory, { sdkGeneratedFiles = false } = {}) {
	const indexEntries = await run('git', ['-C', directory, 'ls-files', '-v', '-z'], { capture: true });
	if (indexEntries.split('\0').filter(Boolean).some((entry) => !entry.startsWith('H '))) {
		throw new Error(`Hidden or unresolved index flags in pinned source checkout: ${directory}`);
	}
	await run('git', ['-C', directory, 'diff', '--exit-code'], { capture: true });
	await run('git', ['-C', directory, 'diff', '--cached', '--exit-code'], { capture: true });
	const untracked = await run('git', ['-C', directory, 'ls-files', '--others', '-z'], { capture: true });
	const generated = new Set(sdkGeneratedFiles ? sdkGeneratedPaths : []);
	if (untracked.split('\0').filter(Boolean).some((name) => !generated.has(name.split('/')[0]))) {
		throw new Error(`Unexpected untracked or ignored files in pinned source checkout: ${directory}`);
	}
}

async function checkout(pin, directory, options = {}) {
	if (!(await stat(path.join(directory, '.git')).catch(() => null))) {
		await mkdir(directory, { recursive: true });
		await run('git', ['init', '--quiet', directory]);
		await run('git', ['-C', directory, 'remote', 'add', 'origin', pin.repository]);
		await run('git', ['-C', directory, 'fetch', '--depth=1', 'origin', pin.commit]);
		await run('git', ['-C', directory, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
	}
	const head = await run('git', ['-C', directory, 'rev-parse', 'HEAD'], { capture: true });
	if (head !== pin.commit) throw new Error(`Source checkout mismatch at ${directory}`);
	await assertCleanCheckout(directory, options);
}

export async function assertOverlays(manifest) {
	for (const overlay of manifest.overlays) {
		if (sha256(await readFile(path.join(producerRoot, overlay.path))) !== overlay.sha256) {
			throw new Error(`Overlay checksum mismatch: ${overlay.path}`);
		}
	}
}

async function sdkEnvironment(p, manifest) {
	const variables = await run('bash', ['-c', 'source "$1" >/dev/null 2>&1 && env -0', 'ecl-sdk', path.join(p.sdk, 'emsdk_env.sh')], { capture: true });
	const env = Object.fromEntries(variables.split('\0').filter(Boolean).map((entry) => {
		const index = entry.indexOf('=');
		return [entry.slice(0, index), entry.slice(index + 1)];
	}));
	const output = await run(path.join(p.sdk, 'upstream/emscripten/emcc'), ['--version'], { env, capture: true });
	// A fresh SDK prints sanity-check notes first; the version is the `emcc (...) X.Y.Z (hash)` line.
	const version = output.split('\n').find((line) => line.startsWith('emcc ')) ?? '';
	if (!version.includes(` ${manifest.sources.emsdk.version} `)) throw new Error(`Unexpected Emscripten compiler: ${version || output.split('\n')[0]}`);
	return { env: { ...env, EMCC_CORES: '2', BINARYEN_CORES: '2' }, version };
}

export async function prepare(p = paths()) {
	const manifest = await readManifest();
	await assertOverlays(manifest);
	await mkdir(p.work, { recursive: true });
	await checkout(manifest.sources.ecl, p.source);
	if (!process.env.WASM_LLVM_ECL_EMSDK) {
		await checkout(manifest.sources.emsdk, p.sdk, { sdkGeneratedFiles: true });
		await run(path.join(p.sdk, 'emsdk'), ['install', manifest.sources.emsdk.version], { cwd: p.sdk });
		await run(path.join(p.sdk, 'emsdk'), ['activate', manifest.sources.emsdk.version], { cwd: p.sdk });
	}
	const { version } = await sdkEnvironment(p, manifest);
	await writeFile(path.join(p.work, 'prepared.json'), `${JSON.stringify({
		manifestSha256: sha256(await readFile(manifestPath)),
		sourceTreeSha256: await treeHash(p.source),
		emscripten: version
	}, null, 2)}\n`);
	console.log(`Prepared ECL ${manifest.sources.ecl.version} in ${p.work}`);
}

async function copySource(p, target) {
	await rm(target, { recursive: true, force: true });
	await cp(p.source, target, { recursive: true, filter: (source) => path.basename(source) !== '.git' });
}

export async function build(p = paths(), { keep = process.argv.includes('--keep') } = {}) {
	const manifest = await readManifest();
	await assertOverlays(manifest);
	const prepared = JSON.parse(await readFile(path.join(p.work, 'prepared.json'), 'utf8'));
	if (prepared.manifestSha256 !== sha256(await readFile(manifestPath))) throw new Error('Manifest changed; run prepare again');
	if (prepared.sourceTreeSha256 !== await treeHash(p.source)) throw new Error('Prepared ECL source tree changed');
	const sdk = await sdkEnvironment(p, manifest);
	if (sdk.version !== prepared.emscripten) throw new Error('Prepared Emscripten SDK changed');

	// 1. Native host ECL of the same revision compiles the Lisp core to C for the target.
	await copySource(p, p.hostBuild);
	await run('./configure', [`--prefix=${p.host}`, ...manifest.host.configure], { cwd: p.hostBuild });
	await run('make', [`-j${jobs()}`], { cwd: p.hostBuild });
	await run('make', ['install'], { cwd: p.hostBuild });

	// 2. Upstream's documented Emscripten cross build (INSTALL, "Cross-compile for the WASM platform").
	await copySource(p, p.crossBuild);
	const crossEnv = {
		...sdk.env,
		ECL_TO_RUN: path.join(p.host, 'bin/ecl'),
		CFLAGS: manifest.cross.cflags.join(' '),
		LDFLAGS: manifest.cross.ldflags.join(' ')
	};
	const emsdkBin = path.join(p.sdk, 'upstream/emscripten');
	await run(path.join(emsdkBin, 'emconfigure'), [
		'./configure',
		...manifest.cross.configure.map((flag) => flag.replace('--with-cross-config=', `--with-cross-config=${p.crossBuild}/`)),
		`--prefix=${path.join(p.work, 'cross-install')}`
	], { cwd: p.crossBuild, env: crossEnv });
	await run(path.join(emsdkBin, 'emmake'), ['make', `-j${jobs()}`], { cwd: p.crossBuild, env: crossEnv });

	// 3. Relink the upstream libraries as an ES module with FS/callMain and caller-owned memory.
	const objects = path.join(p.crossBuild, 'build');
	await rm(p.build, { recursive: true, force: true });
	await mkdir(p.build, { recursive: true });
	const mainObject = path.join(p.build, 'ecl-browser-main.o');
	await run(path.join(emsdkBin, 'emcc'), [
		'-c', '-O0', ...manifest.cross.cflags, `-I${objects}`, `-I${path.join(objects, 'c')}`,
		path.join(producerRoot, 'src/ecl-browser-main.c'), '-o', mainObject
	], { env: sdk.env });
	await run(path.join(emsdkBin, 'emcc'), [
		'-o', path.join(p.build, 'ecl.mjs'), `-L${objects}`, ...manifest.link.flags, mainObject,
		...manifest.link.objects.map((name) => (name.startsWith('-') ? name : path.join(objects, name)))
	], { env: sdk.env });
	await rm(mainObject);
	const assets = {};
	for (const name of runtimeAssets) assets[name] = receiptFor(await readFile(path.join(p.build, name)));
	await writeFile(path.join(p.build, 'build-receipt.json'), `${JSON.stringify({
		manifestSha256: sha256(await readFile(manifestPath)),
		builderSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
		prepared,
		emscripten: sdk.version,
		assets
	}, null, 2)}\n`);
	if (!keep) {
		for (const directory of [p.hostBuild, p.crossBuild, p.host, path.join(p.work, 'cross-install')]) {
			await rm(directory, { recursive: true, force: true });
		}
	}
	console.log(`Built ECL browser module at ${p.build}`);
}

export async function acceptanceHashes(root = producerRoot) {
	return Object.fromEntries(await Promise.all(acceptanceInputs.map(async (name) => [name, sha256(await readFile(path.join(root, name)))])));
}

export async function readFixtures() {
	return Object.fromEntries(await Promise.all(fixtureNames.map(async (name) => [name, await readFile(path.join(producerRoot, 'fixtures', name), 'utf8')])));
}

const readBuildAsset = (directory) => (name) => readFile(path.join(directory, name));

export async function assertAcceptance(evidence, readAsset) {
	const expected = await acceptanceHashes();
	if (JSON.stringify(evidence?.inputs) !== JSON.stringify(expected)) throw new Error('ECL acceptance inputs changed; rerun the smokes');
	for (const check of ['stdinStdout', 'unhandledCondition', 'garbageCollection', 'recursionTrap']) {
		if (evidence.checks?.[check] !== true) throw new Error(`Missing successful ECL acceptance check: ${check}`);
	}
	for (const name of runtimeAssets) assertReceipt(await readAsset(name), evidence.assets?.[name], `${name} acceptance evidence`);
}

export async function smoke(p = paths()) {
	const { acceptEcl, runEcl } = await import('./harness.mjs');
	const { default: createModule } = await import(pathToFileURL(path.join(p.build, 'ecl.mjs')).href);
	const wasmBinary = await readFile(path.join(p.build, 'ecl.wasm'));
	const checks = await acceptEcl((name, source, stdin) => runEcl({ createModule, wasmBinary, source, stdin }), await readFixtures());
	const report = {
		engine: `Node ${process.version}`,
		inputs: await acceptanceHashes(),
		checks,
		assets: Object.fromEntries(await Promise.all(runtimeAssets.map(async (name) => [name, receiptFor(await readFile(path.join(p.build, name)))])))
	};
	await assertAcceptance(report, readBuildAsset(p.build));
	await writeFile(path.join(p.build, 'smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify(report, null, 2));
}

export async function browserSmoke(p = paths()) {
	const { createServer } = await import('node:http');
	const { chromium } = await import('playwright-core');
	const routes = new Map([
		['/ecl.mjs', path.join(p.build, 'ecl.mjs')],
		['/ecl.wasm', path.join(p.build, 'ecl.wasm')],
		['/harness.mjs', path.join(producerRoot, 'scripts/harness.mjs')],
		['/browser-worker.mjs', path.join(producerRoot, 'scripts/browser-worker.mjs')]
	]);
	const server = createServer(async (request, response) => {
		if (request.url === '/') {
			response.setHeader('Content-Type', 'text/html');
			response.end('<!doctype html><title>ECL acceptance</title>');
			return;
		}
		const filename = routes.get(request.url);
		if (!filename) { response.writeHead(404); response.end(); return; }
		response.setHeader('Content-Type', filename.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
		response.end(await readFile(filename));
	});
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
	let browser;
	try {
		browser = await chromium.launch({ headless: true, executablePath: process.env.ECL_CHROMIUM_EXECUTABLE || undefined });
		const page = await browser.newPage();
		await page.goto(`http://127.0.0.1:${server.address().port}/`);
		const { acceptEcl } = await import('./harness.mjs');
		const checks = await acceptEcl((name, source, stdin) => page.evaluate(({ source, stdin }) => new Promise((resolve, reject) => {
			// Each run uses a fresh module Worker, matching the consumer's per-run lifetime and stack.
			const worker = new Worker('/browser-worker.mjs', { type: 'module' });
			const timeout = setTimeout(() => { worker.terminate(); reject(new Error('ECL exceeded 120 seconds')); }, 120_000);
			worker.onerror = (event) => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)); };
			worker.onmessage = ({ data }) => {
				clearTimeout(timeout);
				worker.terminate();
				if (data.error) reject(new Error(data.error));
				else resolve(data.result);
			};
			worker.postMessage({ source, stdin });
		}), { source, stdin }), await readFixtures());
		const report = {
			engine: `Chromium ${browser.version()}; ECL runs in module Workers`,
			inputs: await acceptanceHashes(),
			checks,
			assets: Object.fromEntries(await Promise.all(runtimeAssets.map(async (name) => [name, receiptFor(await readFile(path.join(p.build, name)))])))
		};
		await assertAcceptance(report, readBuildAsset(p.build));
		await writeFile(path.join(p.build, 'browser-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
		console.log(JSON.stringify(report, null, 2));
	} finally {
		await browser?.close();
		await new Promise((resolve) => server.close(resolve));
	}
}

async function assertReleaseEntries(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	if (entries.length !== releaseFiles.length || entries.some((entry) => !entry.isFile() || !releaseFiles.includes(entry.name))) {
		throw new Error(`ECL release directory must contain exactly ${releaseFiles.join(', ')}`);
	}
}

export async function verify(directory = paths().release) {
	await assertReleaseEntries(directory);
	const manifest = await readManifest();
	const receipt = JSON.parse(await readFile(path.join(directory, 'producer-receipt.json'), 'utf8'));
	if (receipt.schemaVersion !== 1 || receipt.producerId !== manifest.producerId ||
		receipt.manifestSha256 !== sha256(await readFile(manifestPath)) ||
		receipt.sources?.ecl?.commit !== manifest.sources.ecl.commit) {
		throw new Error('ECL receipt does not match the producer manifest');
	}
	if (receipt.build?.builderSha256 !== sha256(await readFile(fileURLToPath(import.meta.url)))) {
		throw new Error('ECL receipt was built with a different build script');
	}
	const delivery = await readFile(path.join(directory, deliveryName));
	const expectedDelivery = receipt.delivery?.[deliveryName];
	if (expectedDelivery?.encoding !== 'gzip' || expectedDelivery?.logicalPath !== 'ecl.wasm') {
		throw new Error('ECL receipt must describe ecl.wasm.gz as gzip delivery of ecl.wasm');
	}
	assertReceipt(delivery, expectedDelivery, deliveryName);
	let wasm;
	try {
		wasm = gunzipSync(delivery, { maxOutputLength: 64 * 1024 * 1024 });
	} catch (error) {
		throw new Error(`${deliveryName} is not valid gzip data`, { cause: error });
	}
	const runtime = { 'ecl.mjs': await readFile(path.join(directory, 'ecl.mjs')), 'ecl.wasm': wasm };
	const readAsset = async (name) => runtime[name];
	await assertAcceptance(receipt.smoke, readAsset);
	await assertAcceptance(receipt.browserSmoke, readAsset);
	for (const name of runtimeAssets) {
		const bytes = runtime[name];
		assertReceipt(bytes, receipt.assets?.[name], name);
		assertReceipt(bytes, receipt.build.assets?.[name], `${name} build evidence`);
		if (name.endsWith('.wasm')) await WebAssembly.compile(bytes);
	}
	console.log(`Verified ECL producer artifacts in ${directory}`);
	return receipt;
}

export async function packageRuntime(p = paths()) {
	const manifest = await readManifest();
	const build = JSON.parse(await readFile(path.join(p.build, 'build-receipt.json'), 'utf8'));
	if (build.manifestSha256 !== sha256(await readFile(manifestPath))) throw new Error('Build used another manifest; rebuild before packaging');
	if (build.builderSha256 !== sha256(await readFile(fileURLToPath(import.meta.url)))) throw new Error('Build script changed; rebuild before packaging');
	const smokeReport = JSON.parse(await readFile(path.join(p.build, 'smoke.json'), 'utf8'));
	const browserReport = JSON.parse(await readFile(path.join(p.build, 'browser-smoke.json'), 'utf8'));
	await assertAcceptance(smokeReport, readBuildAsset(p.build));
	await assertAcceptance(browserReport, readBuildAsset(p.build));
	const assets = {};
	for (const name of runtimeAssets) {
		const bytes = await readFile(path.join(p.build, name));
		assertReceipt(bytes, build.assets[name], `${name} build evidence`);
		assets[name] = receiptFor(bytes);
	}
	const staging = `${p.release}.staging`;
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { recursive: true });
	await copyFile(path.join(p.build, 'ecl.mjs'), path.join(staging, 'ecl.mjs'));
	const compressed = gzipSync(await readFile(path.join(p.build, 'ecl.wasm')), { level: 9 });
	await writeFile(path.join(staging, deliveryName), compressed);
	await writeFile(path.join(staging, 'producer-receipt.json'), `${JSON.stringify({
		schemaVersion: 1,
		producerId: manifest.producerId,
		manifestSha256: build.manifestSha256,
		runtimeHost: manifest.runtimeHost,
		sources: manifest.sources,
		overlays: manifest.overlays,
		link: manifest.link,
		invocation: {
			factory: 'default export of ecl.mjs (MODULARIZE, EXPORT_ES6)',
			moduleOptions: ['noInitialRun: true', 'wasmBinary', 'wasmMemory (initial 64 MiB, maximum <= 2 GiB)', 'stdin', 'stdout', 'stderr'],
			args: ['--norc', '--eval', '<LOAD form from scripts/harness.mjs loadForm()>']
		},
		build,
		smoke: smokeReport,
		browserSmoke: browserReport,
		assets,
		delivery: { [deliveryName]: { ...receiptFor(compressed), encoding: 'gzip', logicalPath: 'ecl.wasm' } }
	}, null, 2)}\n`);
	await verify(staging);
	await rm(p.release, { recursive: true, force: true });
	await rename(staging, p.release);
	await rm(p.artifacts, { recursive: true, force: true });
	await cp(p.release, p.artifacts, { recursive: true });
	await verify(p.artifacts);
	console.log(`Packaged ECL browser runtime to ${p.release} and ${p.artifacts}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [command, argument] = process.argv.slice(2);
	const commands = { prepare, build, smoke, 'browser-smoke': browserSmoke, package: packageRuntime, verify };
	if (!commands[command]) throw new Error('Usage: producer.mjs prepare|build [--keep]|smoke|browser-smoke|package|verify [DIRECTORY]');
	if (command === 'verify') await verify(argument ? path.resolve(argument) : undefined);
	else await commands[command]();
}
