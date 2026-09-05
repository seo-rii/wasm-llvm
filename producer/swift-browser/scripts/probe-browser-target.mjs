#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OFFICIAL_SWIFT_VERSION, OFFICIAL_WASM_SDK_ID, assertWasm, findBuiltWasm, run
} from './probe-toolchain.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const PRODUCER_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const REPO_ROOT = path.resolve(PRODUCER_ROOT, '..', '..');
const require = createRequire(import.meta.url);
export const CASES = [
  { name: 'sum-unicode-eof', stdin: '3\n10 20 30\n안녕\n', expected: 'sum=60\ntext=안녕\neof=true\n' },
  { name: 'unterminated-final-line', stdin: '2\n-5 9\nlast', expected: 'sum=4\ntext=last\neof=true\n' },
  { name: 'empty-eof', stdin: '', expected: 'sum=0\ntext=<eof>\neof=true\n' }
];

export function validateResult(fixture, result) {
  if (!result || result.error || result.exitCode !== 0 || result.stderr !== '' || result.stdout !== fixture.expected) {
    throw new Error('Swift browser target fixture failed: ' + fixture.name + ': ' + JSON.stringify(result));
  }
}

export function targetGates(results) {
  const passed = results.length === CASES.length && CASES.every((fixture, index) => {
    try { validateResult(fixture, results[index]); return true; } catch { return false; }
  });
  return { browserTargetStdinStdout: passed, browserHostedCompiler: false, browserHostedSwiftPM: false, ready: false };
}

async function serve(wasmBytes) {
  const shimDirectory = path.dirname(require.resolve('@bjorn3/browser_wasi_shim'));
  const worker = await readFile(path.join(PRODUCER_ROOT, 'test', 'browser-target-worker.mjs'));
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      if (url.pathname === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><title>Swift target acceptance</title>');
      } else if (url.pathname === '/program.wasm') {
        response.setHeader('Content-Type', 'application/wasm');
        response.end(wasmBytes);
      } else if (url.pathname === '/worker.mjs') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(worker);
      } else if (/^\/shim\/[a-z_]+\.js$/u.test(url.pathname)) {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(await readFile(path.join(shimDirectory, url.pathname.slice('/shim/'.length))));
      } else { response.writeHead(404); response.end(); }
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}

export async function probeBrowserTarget({ workRoot, executablePath } = {}) {
  workRoot ??= path.join(REPO_ROOT, 'out', 'swift-browser-target');
  await mkdir(workRoot, { recursive: true });
  const directory = await mkdtemp(path.join(workRoot, 'probe-'));
  const receipt = { format: 'wasm-llvm-swift-browser-target-v1', startedAt: new Date().toISOString(),
    compilerHost: 'native', sdk: OFFICIAL_WASM_SDK_ID, status: 'failed', results: [], gates: targetGates([]) };
  let browser;
  let server;
  try {
    const version = await run('swift', ['--version']);
    if (!version.stdout.startsWith('Swift version ' + OFFICIAL_SWIFT_VERSION + ' ')) {
      throw new Error('Expected native Swift ' + OFFICIAL_SWIFT_VERSION + ', got ' + version.stdout);
    }
    receipt.compilerVersion = version.stdout.trim();
    const source = await readFile(path.join(PRODUCER_ROOT, 'fixtures', 'browser-stdin.swift'));
    receipt.fixtureSha256 = createHash('sha256').update(source).digest('hex');
    await mkdir(path.join(directory, 'Sources', 'BrowserStdin'), { recursive: true });
    await writeFile(path.join(directory, 'Sources', 'BrowserStdin', 'main.swift'), source);
    await writeFile(path.join(directory, 'Package.swift'), '// swift-tools-version: 6.3\nimport PackageDescription\nlet package = Package(name: "BrowserStdin", targets: [.executableTarget(name: "BrowserStdin")])\n');
    receipt.command = ['swift', 'build', '--swift-sdk', OFFICIAL_WASM_SDK_ID, '--jobs', '2'];
    await run(receipt.command[0], receipt.command.slice(1), { cwd: directory });
    const output = await findBuiltWasm(path.join(directory, '.build'));
    if (!output) throw new Error('Native Swift build did not produce a Wasm target');
    await assertWasm(output);
    const wasmBytes = await readFile(output);
    receipt.artifact = { path: output, bytes: wasmBytes.length, sha256: createHash('sha256').update(wasmBytes).digest('hex') };
    const host = await serve(wasmBytes);
    server = host.server;
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    receipt.browser = await browser.version();
    const page = await browser.newPage();
    await page.goto(host.url);
    for (const fixture of CASES) {
      const result = await page.evaluate(async (stdin) => {
        const bytes = await (await fetch('/program.wasm')).arrayBuffer();
        return await new Promise((resolve, reject) => {
          const worker = new Worker('/worker.mjs', { type: 'module' });
          const timer = setTimeout(() => { worker.terminate(); reject(new Error('Swift target timed out')); }, 15000);
          worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
          worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); resolve(data); };
          worker.postMessage({ stdin, bytes }, [bytes]);
        });
      }, fixture.stdin);
      receipt.results.push(result);
      validateResult(fixture, result);
      console.log('PASS ' + fixture.name);
    }
    receipt.gates = targetGates(receipt.results);
    receipt.status = 'passed';
  } catch (error) {
    receipt.error = error.message;
  } finally {
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    receipt.completedAt = new Date().toISOString();
    const receiptPath = path.join(directory, 'receipt.json');
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ receipt: receiptPath, status: receipt.status, gates: receipt.gates, error: receipt.error }));
  }
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
  const args = process.argv.slice(2).filter((item) => item !== '--');
  if (args.includes('--help')) {
    console.log('Usage: node producer/swift-browser/scripts/probe-browser-target.mjs [--work-root DIR] [--chromium FILE]');
  } else {
    try {
      const options = {};
      while (args.length) {
        const option = args.shift();
        if (!['--work-root', '--chromium'].includes(option) || !args[0] || args[0].startsWith('--')) throw new Error('Invalid option: ' + option);
        options[option === '--work-root' ? 'workRoot' : 'executablePath'] = path.resolve(args.shift());
      }
      if ((await probeBrowserTarget(options)).status !== 'passed') process.exitCode = 1;
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
