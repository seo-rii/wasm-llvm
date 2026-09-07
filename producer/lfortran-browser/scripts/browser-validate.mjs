#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTPUT_NAMES, PRODUCER_ROOT, VALIDATION_CASES, sha256 } from './shared.mjs';
import { verifyArtifacts } from './producer.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const WORKER_FILE = path.join(PRODUCER_ROOT, 'test/browser-worker.mjs');

export function validateBrowserCase(expected, actual) {
	if (!actual || actual.error || actual.exitCode !== expected.exitCode || actual.stdout !== expected.stdout) {
		throw new Error('LFortran browser case failed: ' + expected.name + ': ' + JSON.stringify(actual));
	}
	if (expected.exitCode === 0) {
		if (actual.stderr !== '' || !['.o', '.wasm'].every((suffix) => actual.generated?.some((item) =>
			item.name.endsWith(suffix) && Number.isSafeInteger(item.size) && item.size > 8 && /^[a-f0-9]{64}$/u.test(item.sha256)))) {
			throw new Error('LFortran browser case lacks clean LLVM compilation/evaluation evidence: ' + expected.name);
		}
	} else if (!actual.stderr?.includes('this_symbol_is_not_declared')) {
		throw new Error('LFortran browser case lacks the upstream symbol diagnostic');
	}
}

export async function validateBrowser(directory, { executablePath, receiptPath } = {}) {
	directory = path.resolve(directory);
	// Browser checks extend an already-verified Node compiler/evaluator build.
	const producer = await verifyArtifacts(directory);
	receiptPath ??= path.join(path.dirname(directory), 'browser-acceptance-' + randomUUID() + '.json');
	const receipt = {
		format: 'wasm-llvm-lfortran-browser-acceptance-v1', startedAt: new Date().toISOString(),
		status: 'failed', compilerHost: 'chromium-worker', backend: 'llvm',
		artifacts: producer.files, source: producer.source, producerInputs: producer.inputs,
		harness: { scriptSha256: await sha256(THIS_FILE), workerSha256: await sha256(WORKER_FILE) },
		cases: [], consumerRegistration: false
	};
	let browser;
	let server;
	try {
		const workerBytes = await readFile(WORKER_FILE);
		server = createServer((request, response) => {
			const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
			response.setHeader('Cache-Control', 'no-store');
			response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
			response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
			if (pathname === '/') {
				response.setHeader('Content-Type', 'text/html');
				response.end('<!doctype html><title>LFortran compiler acceptance</title>');
			} else if (pathname === '/worker.mjs') {
				response.setHeader('Content-Type', 'text/javascript');
				response.end(workerBytes);
			} else if (OUTPUT_NAMES.some((name) => pathname === '/artifacts/' + name)) {
				const name = pathname.slice('/artifacts/'.length);
				response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
				const stream = createReadStream(path.join(directory, name));
				stream.on('error', () => { if (!response.headersSent) response.writeHead(500); response.end(); });
				response.on('close', () => stream.destroy());
				stream.pipe(response);
			} else { response.writeHead(404); response.end(); }
		});
		await new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', resolve);
		});
		const { chromium } = await import('playwright-core');
		browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
		receipt.chromiumVersion = browser.version();
		const page = await browser.newPage();
		await page.goto('http://127.0.0.1:' + server.address().port);
		for (const fixture of VALIDATION_CASES) {
			const source = await readFile(path.join(PRODUCER_ROOT, 'fixtures', fixture.fixture), 'utf8');
			const actual = await page.evaluate(async (data) => await new Promise((resolve, reject) => {
				const worker = new Worker('/worker.mjs', { type: 'module' });
				const timer = setTimeout(() => { worker.terminate(); reject(new Error('LFortran browser compiler timed out')); }, 180000);
				worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
				worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); resolve(data); };
				worker.postMessage(data);
			}), { source, stdin: fixture.stdin });
			receipt.cases.push({ name: fixture.name, ...actual });
			validateBrowserCase(fixture, actual);
			console.log('PASS ' + fixture.name);
		}
		const current = await verifyArtifacts(directory);
		if (JSON.stringify(current.files) !== JSON.stringify(receipt.artifacts) ||
			JSON.stringify(current.inputs) !== JSON.stringify(receipt.producerInputs) ||
			await sha256(THIS_FILE) !== receipt.harness.scriptSha256 ||
			await sha256(WORKER_FILE) !== receipt.harness.workerSha256) {
			throw new Error('Compiler or acceptance inputs changed during browser validation');
		}
		receipt.status = 'passed';
	} catch (error) {
		receipt.error = error.message;
	} finally {
		await browser?.close();
		if (server) await new Promise((resolve) => server.close(resolve));
		receipt.completedAt = new Date().toISOString();
		await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
		console.log(JSON.stringify({ receipt: receiptPath, status: receipt.status, error: receipt.error }));
	}
	return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		const args = process.argv.slice(2).filter((arg) => arg !== '--');
		const directory = args.shift();
		if (!directory || directory === '--help') {
			console.log('browser-validate.mjs <artifacts> [--chromium FILE] [--receipt FILE]');
		} else {
			const options = {};
			while (args.length) {
				const flag = args.shift();
				if (!['--chromium', '--receipt'].includes(flag) || !args[0] || args[0].startsWith('--')) throw new Error('Invalid option: ' + flag);
				options[flag === '--chromium' ? 'executablePath' : 'receiptPath'] = path.resolve(args.shift());
			}
			if ((await validateBrowser(directory, options)).status !== 'passed') process.exitCode = 1;
		}
	} catch (error) { console.error(error.message); process.exitCode = 1; }
}
