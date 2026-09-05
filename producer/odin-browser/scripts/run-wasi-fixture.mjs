#!/usr/bin/env node

// Producer acceptance harness. Application Workers remain owned by wasm-idle.
import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';

const [file] = process.argv.slice(2);
if (!file || process.argv.length !== 3) throw new Error('Usage: run-wasi-fixture.mjs program.wasm');
const wasi = new WASI({
	version: 'preview1',
	args: ['stdin-sum'],
	env: {},
	preopens: {},
	returnOnExit: true
});
const module = await WebAssembly.compile(await readFile(file));
const instance = await WebAssembly.instantiate(module, {
	wasi_snapshot_preview1: wasi.wasiImport
});
process.exitCode = wasi.start(instance) ?? 0;
