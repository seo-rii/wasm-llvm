#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASI } from 'node:wasi';

const THIS_FILE = fileURLToPath(import.meta.url);
const PRODUCER_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const require = createRequire(import.meta.url);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const CASES = [
  { name: 'sum-unicode-eof', stdin: '3\n10 20 30\n안녕\n', expected: 'sum=60\ntext=안녕\neof=true\n' },
  { name: 'unterminated-final-line', stdin: '2\n-5 9\nlast', expected: 'sum=4\ntext=last\neof=true\n' },
  { name: 'empty-eof', stdin: '', expected: 'sum=0\ntext=<eof>\neof=true\n' }
];

export function assertCompilerVersion(version, source) {
  const fields = Object.fromEntries(version.split('\n').slice(1).map((line) => line.split(': ')));
  if (fields.release !== source.version || fields['commit-hash'] !== source.commit || fields.host !== 'x86_64-unknown-linux-gnu') {
    throw new Error('Native rustc does not match the pinned release, source commit and host');
  }
}

export function validateResult(fixture, result) {
  if (!result || result.error || result.exitCode !== 0 || result.stdout !== fixture.expected || result.stderr !== '') {
    throw new Error('Rust native target fixture failed: ' + fixture.name + ': ' + JSON.stringify(result));
  }
}

function passed(results) {
  return results.length === CASES.length && CASES.every((fixture, index) => {
    try { validateResult(fixture, results[index]); return true; } catch { return false; }
  });
}

export function targetGates(nodeResults = [], browserResults = []) {
  return { nodeWasiStdinStdout: passed(nodeResults), browserTargetStdinStdout: passed(browserResults),
    browserHostedCompiler: false, ready: false };
}

function command(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.signal) throw new Error(result.error?.message ?? 'Compiler terminated by ' + result.signal);
  return { command: [executable, ...args], exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function runNodeCase(directory, module, fixture) {
  const prefix = path.join(directory, fixture.name);
  await writeFile(prefix + '.stdin', fixture.stdin);
  const handles = await Promise.all([open(prefix + '.stdin', 'r'), open(prefix + '.stdout', 'w'), open(prefix + '.stderr', 'w')]);
  let exitCode;
  try {
    const host = new WASI({ version: 'preview1', args: ['program.wasm'], env: {}, returnOnExit: true,
      stdin: handles[0].fd, stdout: handles[1].fd, stderr: handles[2].fd });
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: host.wasiImport });
    exitCode = host.start(instance);
  } finally { await Promise.all(handles.map((handle) => handle.close())); }
  return { name: fixture.name, exitCode, stdout: await readFile(prefix + '.stdout', 'utf8'), stderr: await readFile(prefix + '.stderr', 'utf8') };
}

async function runBrowserCases(wasmBytes, executablePath) {
  const shimDirectory = path.dirname(require.resolve('@bjorn3/browser_wasi_shim'));
  const worker = await readFile(path.join(PRODUCER_ROOT, 'test', 'native-target-worker.mjs'));
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Rust native target acceptance</title>'); }
      else if (url.pathname === '/program.wasm') { response.setHeader('Content-Type', 'application/wasm'); response.end(wasmBytes); }
      else if (url.pathname === '/worker.mjs') { response.setHeader('Content-Type', 'text/javascript'); response.end(worker); }
      else if (/^\/shim\/[a-z_]+\.js$/u.test(url.pathname)) {
        response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(path.join(shimDirectory, url.pathname.slice('/shim/'.length))));
      } else { response.writeHead(404); response.end(); }
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let browser;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + server.address().port);
    const results = [];
    for (const fixture of CASES) {
      const result = await page.evaluate(async (stdin) => {
        const bytes = await (await fetch('/program.wasm')).arrayBuffer();
        return await new Promise((resolve, reject) => {
          const worker = new Worker('/worker.mjs', { type: 'module' });
          const timer = setTimeout(() => { worker.terminate(); reject(new Error('Rust target timed out')); }, 15000);
          worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
          worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); resolve(data); };
          worker.postMessage({ stdin, bytes }, [bytes]);
        });
      }, fixture.stdin);
      results.push({ name: fixture.name, ...result });
      validateResult(fixture, result);
    }
    const shimPackage = JSON.parse(await readFile(path.join(shimDirectory, '..', 'package.json'), 'utf8'));
    return { version: await browser.version(), shimVersion: shimPackage.version, results };
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function probeNativeTarget({ rustc = 'rustc', workRoot = path.join(PRODUCER_ROOT, '../../out/rust-native-target'), browser = false, executablePath } = {}) {
  await mkdir(workRoot, { recursive: true });
  const directory = await mkdtemp(path.join(workRoot, 'probe-'));
  const receipt = { format: 'wasm-llvm-rust-native-target-v1', startedAt: new Date().toISOString(), compilerHost: 'native',
    status: 'failed', node: process.version, target: 'wasm32-wasip1', nodeResults: [], browserResults: [], gates: targetGates() };
  try {
    const manifestBytes = await readFile(path.join(PRODUCER_ROOT, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes);
    receipt.manifestSha256 = sha256(manifestBytes);
    receipt.source = manifest.sources.rust;
    const version = command(rustc, ['-vV']);
    if (version.exitCode !== 0) throw new Error('Unable to run native rustc: ' + version.stderr);
    assertCompilerVersion(version.stdout, receipt.source);
    receipt.compiler = version;
    receipt.sourceFiles = {};
    for (const name of ['scripts/probe-native-target.mjs', 'fixtures/wasi-stdin.rs', 'fixtures/type-error.rs', 'test/native-target-worker.mjs']) {
      receipt.sourceFiles[name] = sha256(await readFile(path.join(PRODUCER_ROOT, name)));
    }
    const output = path.join(directory, 'program.wasm');
    receipt.compile = command(rustc, ['--edition=2024', '--target=wasm32-wasip1', '-C', 'opt-level=2', '-o', output, path.join(PRODUCER_ROOT, 'fixtures/wasi-stdin.rs')]);
    if (receipt.compile.exitCode !== 0) throw new Error('Native compile failed: ' + receipt.compile.stderr);
    receipt.diagnostic = command(rustc, ['--edition=2024', '--target=wasm32-wasip1', '--emit=metadata', '-o', path.join(directory, 'invalid.rmeta'), path.join(PRODUCER_ROOT, 'fixtures/type-error.rs')]);
    if (receipt.diagnostic.exitCode === 0 || !receipt.diagnostic.stderr.includes('error[E0308]')) throw new Error('Expected E0308 type diagnostic');
    const wasmBytes = await readFile(output);
    const module = await WebAssembly.compile(wasmBytes);
    receipt.artifact = { bytes: wasmBytes.length, sha256: sha256(wasmBytes), imports: WebAssembly.Module.imports(module) };
    if (receipt.artifact.imports.some((entry) => entry.module !== 'wasi_snapshot_preview1')) throw new Error('Unexpected target imports');
    for (const fixture of CASES) {
      const result = await runNodeCase(directory, module, fixture);
      receipt.nodeResults.push(result); validateResult(fixture, result);
    }
    if (browser) {
      receipt.browser = await runBrowserCases(wasmBytes, executablePath);
      receipt.browserResults = receipt.browser.results;
    }
    receipt.gates = targetGates(receipt.nodeResults, receipt.browserResults);
    receipt.status = 'passed';
  } catch (error) { receipt.error = error.message; }
  receipt.completedAt = new Date().toISOString();
  const receiptPath = path.join(directory, 'receipt.json');
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ receipt: receiptPath, status: receipt.status, gates: receipt.gates, error: receipt.error }));
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    while (args.length) {
      const option = args.shift();
      if (option === '--browser') { options.browser = true; continue; }
      if (!['--rustc', '--work-root', '--chromium'].includes(option) || !args[0] || args[0].startsWith('--')) throw new Error('Invalid option: ' + option);
      options[{ '--rustc': 'rustc', '--work-root': 'workRoot', '--chromium': 'executablePath' }[option]] = path.resolve(args.shift());
    }
    if ((await probeNativeTarget(options)).status !== 'passed') process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
