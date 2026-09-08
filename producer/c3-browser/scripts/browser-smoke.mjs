#!/usr/bin/env node

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { assertCompilerSmoke } from './smoke.mjs';
import { paths, producerRoot, sha256 } from './producer.mjs';
import { acceptanceHashes, assertAcceptanceInputs } from './evidence.mjs';

const directory = path.resolve(process.argv[2] || paths().build);
if (process.argv.length > 3) throw new Error('Usage: browser-smoke.mjs [COMPILER_DIRECTORY]');
const inputs = await acceptanceHashes();
const routes = new Map([
	['/c3c.mjs', path.join(directory, 'c3c.mjs')],
	['/c3c.wasm', path.join(directory, 'c3c.wasm')],
	['/smoke-worker.mjs', path.join(producerRoot, 'scripts/smoke-worker.mjs')]
]);
const server = createServer(async (request, response) => {
	response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
	response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
	if (request.url === '/') {
		response.setHeader('Content-Type', 'text/html');
		response.end('<!doctype html><title>C3 compiler acceptance</title>');
		return;
	}
	const filename = routes.get(request.url);
	if (!filename) { response.writeHead(404); response.end(); return; }
	try {
		response.setHeader('Content-Type', filename.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
		response.end(await readFile(filename));
	} catch {
		response.writeHead(500);
		response.end();
	}
});
await new Promise((resolve, reject) => {
	server.once('error', reject);
	server.listen(0, '127.0.0.1', resolve);
});
let browser;
try {
	browser = await chromium.launch({ headless: true, executablePath: process.env.C3_CHROMIUM_EXECUTABLE || undefined });
	const page = await browser.newPage();
	await page.goto(`http://127.0.0.1:${server.address().port}/`);
	let linkedProgram;
	const checks = await assertCompilerSmoke(async (source, args) => {
		const result = await page.evaluate(({ source, args }) => new Promise((resolve, reject) => {
			const worker = new Worker('/smoke-worker.mjs', { type: 'module' });
			const finish = (error, value) => {
				clearTimeout(timeout);
				worker.terminate();
				if (error) reject(error);
				else resolve(value);
			};
			const timeout = setTimeout(() => finish(new Error('Browser compiler exceeded 120 seconds')), 120_000);
			worker.onerror = (event) => finish(new Error(event.message));
			worker.onmessage = ({ data }) => {
				if (data.error) { finish(new Error(data.error)); return; }
				finish(null, {
					...data.result,
					files: data.result.files.map((file) => ({ ...file, bytes: Array.from(file.bytes) }))
				});
			};
			worker.postMessage({ compilerUrl: new URL('/c3c.mjs', location.href).href, source, args });
		}), { source, args });
		linkedProgram = result.files.find((file) => file.path === '/work/program.wasm')?.bytes || linkedProgram;
		return { ...result, files: result.files.map((file) => ({ ...file, bytes: Uint8Array.from(file.bytes) })) };
	});
	const guest = await page.evaluate(async (bytes) => {
		const input = new TextEncoder().encode('C3 stdin: 안녕\n');
		const output = [];
		let offset = 0;
		const { instance } = await WebAssembly.instantiate(Uint8Array.from(bytes), {
			env: {
				readByte: () => offset < input.length ? input[offset++] : -1,
				writeByte: (value) => output.push(value)
			}
		});
		instance.exports._initialize?.();
		const sum = instance.exports.sum_squares(5);
		instance.exports.echo();
		return { sum, output: new TextDecoder().decode(Uint8Array.from(output)) };
	}, linkedProgram);
	if (guest.sum !== 55 || guest.output !== 'C3 stdin: 안녕\n') throw new Error('Compiled C3 program failed in Chromium');
	checks.browserGuest = true;
	const report = {
		engine: `Chromium ${browser.version()}; compiler runs in module Workers`,
		inputs,
		checks,
		assets: Object.fromEntries(await Promise.all(['c3c.mjs', 'c3c.wasm'].map(async (name) => {
			const bytes = await readFile(path.join(directory, name));
			return [name, { bytes: bytes.length, sha256: sha256(bytes) }];
		})))
	};
	await assertAcceptanceInputs(report);
	await writeFile(path.join(directory, 'browser-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify(report, null, 2));
} finally {
	await browser?.close();
	await new Promise((resolve) => server.close(resolve));
}
