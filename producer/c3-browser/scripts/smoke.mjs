#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { paths, producerRoot, readManifest, sha256 } from './producer.mjs';
import { acceptanceHashes, assertAcceptanceInputs } from './evidence.mjs';

export async function runCompiler(directory, source, args, timeoutMs = 120_000) {
	const worker = new Worker(new URL('./smoke-worker.mjs', import.meta.url), {
		workerData: { compilerUrl: pathToFileURL(path.join(directory, 'c3c.mjs')).href, source, args }
	});
	try {
		return await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error(`C3 compiler exceeded ${timeoutMs} ms`)), timeoutMs);
			worker.once('message', (message) => {
				clearTimeout(timeout);
				if (message.error) reject(new Error(message.error));
				else resolve(message.result);
			});
			worker.once('error', (error) => { clearTimeout(timeout); reject(error); });
			worker.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Compiler Worker exited before a result (${code})`)); });
		});
	} finally {
		await worker.terminate();
	}
}

export const compilerArgs = (command) => [
	command, '--target', 'wasm32', '--stdlib', '/lib/std', '--threads', '1', '--max-mem', '128',
	'--reloc=none', '--link-libc=no', '--no-entry', '-g0', '--ansi=no',
	...(command === 'compile' ? ['--linker=builtin', '-o', '/work/program.wasm'] : []),
	'/work/main.c3'
];

export async function assertCompilerSmoke(compile) {
	const source = await readFile(path.join(producerRoot, 'fixtures/program.c3'), 'utf8');
	const invalid = await readFile(path.join(producerRoot, 'fixtures/invalid.c3'), 'utf8');
	const compiled = await compile(source, compilerArgs('compile-only'));
	assert.equal(compiled.exitCode, 0, `Compile-only failed:\n${compiled.stdout}\n${compiled.stderr}`);
	// C3 uses .wasm for relocatable wasm32 objects as well as linked programs.
	const objects = compiled.files.filter((file) => /\.(?:o|wasm)$/u.test(file.path));
	assert.ok(objects.length > 0, 'Compiler produced no object files');
	for (const file of objects) {
		const module = await WebAssembly.compile(file.bytes);
		assert.ok(WebAssembly.Module.customSections(module, 'linking').length > 0, `${file.path} is not a relocatable Wasm object`);
	}
	const diagnostic = await compile(invalid, compilerArgs('compile-only'));
	assert.notEqual(diagnostic.exitCode, 0, 'Invalid C3 unexpectedly compiled');
	assert.match(`${diagnostic.stdout}\n${diagnostic.stderr}`, /missing_value/u);
	assert.match(`${diagnostic.stdout}\n${diagnostic.stderr}`, /main\.c3/u);
	const linked = await compile(source, compilerArgs('compile'));
	assert.equal(linked.exitCode, 0, `Builtin link failed:\n${linked.stdout}\n${linked.stderr}`);
	const program = linked.files.find((file) => file.path === '/work/program.wasm');
	assert.ok(program, 'Compiler produced no linked program');
	const input = new TextEncoder().encode('C3 stdin: 안녕\n');
	const output = [];
	let offset = 0;
	const { instance } = await WebAssembly.instantiate(program.bytes, {
		env: {
			readByte: () => offset < input.length ? input[offset++] : -1,
			writeByte: (value) => output.push(value)
		}
	});
	instance.exports._initialize?.();
	assert.equal(instance.exports.sum_squares(5), 55);
	instance.exports.echo();
	assert.deepEqual(Uint8Array.from(output), input, 'Compiled C3 did not preserve UTF-8 stdin/stdout');
	return {
		compileOnly: true,
		invalidSourceDiagnostic: true,
		builtinLink: true,
		arithmetic: true,
		hostByteInputOutput: true,
		objects: objects.map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: sha256(file.bytes) })),
		program: { bytes: program.bytes.length, sha256: sha256(program.bytes) },
		diagnostic: `${diagnostic.stdout}\n${diagnostic.stderr}`.trim()
	};
}

export async function smoke(directory = paths().build) {
	const manifest = await readManifest();
	const inputs = await acceptanceHashes();
	const version = await runCompiler(directory, '', ['--version']);
	assert.equal(version.exitCode, 0);
	assert.match(`${version.stdout}\n${version.stderr}`, new RegExp(manifest.sources.c3.version.replaceAll('.', '\\.')));
	const report = {
		engine: `Node ${process.versions.node} WebAssembly in worker_threads`,
		inputs,
		version: `${version.stdout}\n${version.stderr}`.trim(),
		checks: await assertCompilerSmoke((source, args) => runCompiler(directory, source, args)),
		assets: Object.fromEntries(await Promise.all(['c3c.mjs', 'c3c.wasm'].map(async (name) => {
			const bytes = await readFile(path.join(directory, name));
			return [name, { bytes: bytes.length, sha256: sha256(bytes) }];
		})))
	};
	await assertAcceptanceInputs(report);
	await writeFile(path.join(directory, 'smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify(report, null, 2));
	return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length > 3) throw new Error('Usage: smoke.mjs [COMPILER_DIRECTORY]');
	await smoke(process.argv[2]);
}
