import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../qualification/compile.mjs';

// Synthetic adapter failure tests only. This loader does not compile C/C++.
async function syntheticInvocation(t, behavior) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gcc-host-diagnostics-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const output = path.join(root, 'output');
	await fs.mkdir(output);
	const loader = Buffer.from(`export default async function(options) {
		const files = new Map();
		return {
			HEAPU8: new Uint8Array(1),
			FS: { mkdirTree() {}, chdir() {},
				writeFile(name, bytes) { files.set(name, bytes); },
				readFile(name) { return files.get(name); } },
			callMain() {
				options.print('synthetic stdout before host failure');
				options.printErr('synthetic GCC diagnostic before host failure');
				files.set('/work/main.s', new TextEncoder().encode('stale output must not escape'));
				${behavior}
			}
		};
	}`);
	const payloads = { 'cc1plus.mjs': loader, 'cc1plus.wasm': Buffer.from('0061736d01000000', 'hex'), 'sysroot.tar': Buffer.alloc(1024) };
	const assets = {};
	for (const [name, bytes] of Object.entries(payloads)) {
		await fs.writeFile(path.join(root, name), bytes);
		assets[name === 'sysroot.tar' ? 'sysroot' : name.endsWith('.mjs') ? 'cc1plusJs' : 'cc1plusWasm'] =
			{ path: name, bytes: bytes.length, sha256: sha256(bytes) };
	}
	const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'gcc-x86_64-linux-gnu',
		host: 'wasm32-emscripten', target: 'x86_64-linux-gnu', compiler: { family: 'gcc', version: '13.3.0' },
		linkMode: 'static', sysrootPath: '/sysroot', gccInstallation: '/sysroot/usr/lib/gcc/x86_64-linux-gnu/13',
		resourceDir: '/sysroot/usr/lib/gcc/x86_64-linux-gnu/13/include', gnu: { gccVersion: '13' },
		cpuProfiles: ['x86-64', 'avx2-fma'], assets }));
	await fs.writeFile(path.join(root, 'gcc-toolchain.v1.json'), manifest);
	const request = path.join(root, 'request.json');
	await fs.writeFile(request, JSON.stringify({ code: 'synthetic source', language: 'cpp', emit: 'assembly' }));
	const execution = spawnSync(process.execPath, [fileURLToPath(new URL('../qualification/compile.mjs', import.meta.url)),
		root, sha256(manifest), request, output], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
	assert.ifError(execution.error);
	return { execution, output };
}

test('synthetic Wasm abort retains GCC diagnostics and never writes a compile result', async t => {
	const { execution, output } = await syntheticInvocation(t,
		"throw new WebAssembly.RuntimeError('synthetic Unwind_GetIPInfo abort');");
	assert.equal(execution.status, 1);
	assert.match(execution.stderr, /synthetic stdout before host failure/);
	assert.match(execution.stderr, /synthetic GCC diagnostic before host failure/);
	assert.match(execution.stderr, /synthetic Unwind_GetIPInfo abort/);
	assert.deepEqual(await fs.readdir(output), []);
});

test('synthetic excessive diagnostics remain bounded when the Wasm host aborts', async t => {
	const { execution, output } = await syntheticInvocation(t,
		"options.printErr('x'.repeat(2 * 1024 * 1024)); throw new WebAssembly.RuntimeError('synthetic abort after flood');");
	assert.equal(execution.status, 1);
	assert.match(execution.stderr, /synthetic GCC diagnostic before host failure/);
	assert.match(execution.stderr, /diagnostics truncated/);
	assert.match(execution.stderr, /synthetic abort after flood/);
	assert(Buffer.byteLength(execution.stderr) < 300 * 1024);
	assert.deepEqual(await fs.readdir(output), []);
});

test('synthetic ordinary compiler failure remains a normal result without a stale artifact', async t => {
	const { execution, output } = await syntheticInvocation(t,
		"process.exitCode = 9; options.onExit(9); throw Object.assign(new Error('synthetic expected exit'), { name: 'ExitStatus', status: 9 });");
	assert.equal(execution.status, 0);
	const result = JSON.parse(await fs.readFile(path.join(output, 'result.json'), 'utf8'));
	assert.equal(result.exitCode, 9);
	assert.equal(result.artifact, undefined);
	assert.match(result.stderr, /synthetic GCC diagnostic before host failure/);
	assert.deepEqual(await fs.readdir(output), ['result.json']);
});
