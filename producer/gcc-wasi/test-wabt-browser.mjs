#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = resolve(process.env.GCC_WASI_WORK_DIR ?? `${root}/out/gcc-wasi-work`);
const require = createRequire(resolve(process.env.GCC_WASI_PLAYWRIGHT_PROJECT ?? process.cwd(), 'package.json'));
const { chromium } = require('playwright-core');
const wat = `(module
  (import "env" "__indirect_function_table" (table 0 funcref))
  (func $answer (@sym (name "answer")) (result i32) i32.const 42)
  (func $run (@sym (name "run")) (result i32)
    i32.const 0 (@reloc functable $answer) call_indirect (result i32)))`;
const workerSource = `import createModule from '/as.mjs';
self.onmessage = async ({data}) => {
  try {
    const diagnostics = [];
    const module = await createModule({noInitialRun: true,
      locateFile: (name) => '/' + name,
      print: (message) => diagnostics.push(String(message)),
      printErr: (message) => diagnostics.push(String(message))});
    module.FS.writeFile('/test.wat', data);
    let status = 0;
    try { status = module.callMain(['-r', '--enable-annotations', '/test.wat', '-o', '/test.o']) ?? 0; }
    catch (error) { if (typeof error?.status !== 'number') throw error; status = error.status; }
    self.postMessage({status, diagnostics, bytes: Array.from(module.FS.readFile('/test.o'))});
  } catch (error) { self.postMessage({error: String(error?.stack ?? error)}); }
};`;
const assets = new Map([
  ['/', { type: 'text/html', data: Buffer.from('<!doctype html><title>WABT Worker qualification</title>') }],
  ['/worker.mjs', { type: 'text/javascript', data: Buffer.from(workerSource) }],
  ['/as.mjs', { type: 'text/javascript', data: await readFile(resolve(work, 'wabt-browser/as.mjs')) }],
  ['/as.wasm', { type: 'application/wasm', data: await readFile(resolve(work, 'wabt-browser/as.wasm')) }],
]);
const server = createServer((request, response) => {
  const asset = assets.get(request.url);
  if (!asset) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', asset.type);
  response.setHeader('Cache-Control', 'no-store');
  response.end(asset.data);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const temporary = await mkdtemp(resolve(tmpdir(), 'gcc-wasi-wabt-browser-'));
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.GCC_WASI_CHROMIUM ? { executablePath: process.env.GCC_WASI_CHROMIUM } : {}) });
  const page = await browser.newPage();
  // Private loopback test server; no application origin, WAF or credentials.
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate((source) => new Promise((done, fail) => {
    const worker = new Worker('/worker.mjs', { type: 'module' });
    const timeout = setTimeout(() => { worker.terminate(); fail(new Error('assembler Worker timed out')); }, 120000);
    worker.onmessage = ({ data }) => { clearTimeout(timeout); worker.terminate(); done(data); };
    worker.onerror = (event) => { clearTimeout(timeout); worker.terminate(); fail(new Error(event.message)); };
    worker.postMessage(source);
  }), wat);
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.status, 0, result.diagnostics.join('\n'));
  const input = resolve(temporary, 'test.wat');
  const output = resolve(temporary, 'test.o');
  await writeFile(input, wat);
  execFileSync(resolve(work, 'wabt-native/wat2wasm'), ['-r', '--enable-annotations', input, '-o', output]);
  const object = await readFile(output);
  assert.deepEqual(Buffer.from(result.bytes), object);
  console.log(JSON.stringify({ result: 'passed', browser: await browser.version(),
    execution: 'chromium-module-worker', nativeObjectIdentical: true,
    objectBytes: object.length, assemblerCommit: '651c9ffbce3d0525d2d1324fab79160e5fcf8173' }, null, 2));
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  await rm(temporary, { recursive: true, force: true });
}
