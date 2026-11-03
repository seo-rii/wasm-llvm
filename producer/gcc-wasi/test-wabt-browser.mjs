#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity } from '../clang-browser/cross/package.mjs';
import { inspectTargetFeatures } from './inspect-target-features.mjs';
import { watCases } from './target-features-fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = resolve(process.env.GCC_WASI_WORK_DIR ?? `${root}/out/gcc-wasi-work`);
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  assert(['native-qualification', 'output'].includes(key) && process.argv[i + 1] && !options[key], `Invalid argument ${process.argv[i]}`);
  options[key] = resolve(process.argv[i + 1]);
}
const require = createRequire(resolve(process.env.GCC_WASI_PLAYWRIGHT_PROJECT ?? process.cwd(), 'package.json'));
const { chromium } = require('playwright-core');
const inputs = new Map();
async function readInput(file) { const bytes = await readFile(file); inputs.set(file, identity(bytes)); return bytes; }
const wat = `(module
  (import "env" "__indirect_function_table" (table 0 funcref))
  (func $answer (@sym (name "answer")) (result i32) i32.const 42)
  (func $run (@sym (name "run")) (result i32)
    i32.const 0 (@reloc functable $answer) call_indirect (result i32)))`;
const workerSource = `import createModule from '/as.mjs';
self.onmessage = async ({data}) => {
  try {
    if (data.program) {
      const bytes = Uint8Array.from(data.program);
      const compiled = await WebAssembly.compile(bytes);
      const instance = await WebAssembly.instantiate(compiled, {env:{vector(){}}});
      self.postMessage({valid:WebAssembly.validate(bytes), result:instance.exports.run()});
      return;
    }
    const diagnostics = [];
    const module = await createModule({noInitialRun: true,
      locateFile: (name) => '/' + name,
      print: (message) => diagnostics.push(String(message)),
      printErr: (message) => diagnostics.push(String(message))});
    module.FS.writeFile('/test.wat', data.wat);
    let status = 0;
    try { status = module.callMain([...(data.relocatable ? ['-r'] : []), '--enable-annotations', ...(data.flags || []), '/test.wat', '-o', '/test.o']) ?? 0; }
    catch (error) { if (typeof error?.status !== 'number') throw error; status = error.status; }
    self.postMessage({status, diagnostics, bytes: status === 0 ? Array.from(module.FS.readFile('/test.o')) : null});
  } catch (error) { self.postMessage({error: String(error?.stack ?? error)}); }
};`;
const assets = new Map([
  ['/', { type: 'text/html', data: Buffer.from('<!doctype html><title>WABT Worker qualification</title>') }],
  ['/worker.mjs', { type: 'text/javascript', data: Buffer.from(workerSource) }],
  ['/as.mjs', { type: 'text/javascript', data: await readInput(resolve(work, 'wabt-browser/as.mjs')) }],
  ['/as.wasm', { type: 'application/wasm', data: await readInput(resolve(work, 'wabt-browser/as.wasm')) }],
]);
const nativeReceipt = JSON.parse(await readInput(resolve(work, 'wabt-native/provenance.json')));
const browserReceipt = JSON.parse(await readInput(resolve(work, 'wabt-browser/provenance.json')));
assert.deepEqual(nativeReceipt.source, browserReceipt.source, 'Both assembler hosts must use the same patched source');
assert.deepEqual(nativeReceipt.recipes, browserReceipt.recipes);
assert.equal(nativeReceipt.inputsUnchanged, true); assert.equal(browserReceipt.inputsUnchanged, true);
for (const name of ['as.mjs', 'as.wasm']) assert.deepEqual(identity(assets.get('/' + name).data), browserReceipt.files[name]);
await readInput(fileURLToPath(import.meta.url));
await readInput(fileURLToPath(new URL('./target-features-fixtures.mjs', import.meta.url)));
const assembler = resolve(work, 'wabt-native/wat2wasm');
assert.deepEqual(identity(await readInput(assembler)), nativeReceipt.files.wat2wasm);
const nativeProof = options['native-qualification'] && JSON.parse(await readInput(options['native-qualification']));
if (nativeProof) {
  assert.equal(nativeProof.kind, 'gcc-wasi-native-target-features-qualification');
  assert.equal(nativeProof.status, 'passed'); assert.equal(nativeProof.inputsUnchanged, true);
  assert.deepEqual(nativeProof.assemblerSource, nativeReceipt.source);
  assert.deepEqual(nativeProof.inputs[assembler], nativeReceipt.files.wat2wasm);
  assert.deepEqual(nativeProof.watCases.map(test => test.id), watCases.flatMap(fixture => [`${fixture.id}-module`, `${fixture.id}-object`]));
}
const server = createServer((request, response) => {
  const asset = assets.get(request.url);
  if (!asset) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', asset.type);
  response.setHeader('Cache-Control', 'no-store');
  response.end(asset.data);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const temporary = await mkdtemp(resolve(tmpdir(), 'gcc-wasi-wabt-browser-'));
const report = { kind: 'gcc-wasi-wabt-chromium-target-features-qualification', status: 'running', execution: 'chromium-module-worker',
  assemblerSource: browserReceipt.source, cases: [] };
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.GCC_WASI_CHROMIUM ? { executablePath: process.env.GCC_WASI_CHROMIUM } : {}) });
  report.browser = await browser.version();
  const page = await browser.newPage();
  // Private loopback test server; no application origin, WAF or credentials.
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const inWorker = data => page.evaluate((message) => new Promise((done, fail) => {
    const worker = new Worker('/worker.mjs', { type: 'module' });
    const timeout = setTimeout(() => { worker.terminate(); fail(new Error('assembler Worker timed out')); }, 120000);
    worker.onmessage = ({ data }) => { clearTimeout(timeout); worker.terminate(); done(data); };
    worker.onerror = (event) => { clearTimeout(timeout); worker.terminate(); fail(new Error(event.message)); };
    worker.postMessage(message);
  }), data);
  const result = await inWorker({ wat, relocatable: true });
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.status, 0, result.diagnostics.join('\n'));
  const input = resolve(temporary, 'test.wat'), output = resolve(temporary, 'test.o');
  await writeFile(input, wat);
  execFileSync(assembler, ['-r', '--enable-annotations', input, '-o', output]);
  const object = await readFile(output);
  assert.deepEqual(Buffer.from(result.bytes), object);
  report.tableRelocation = { nativeObjectIdentical: true, ...identity(object) };
  if (nativeProof) for (const fixture of watCases) for (const relocatable of [false, true]) {
    const id = `${fixture.id}-${relocatable ? 'object' : 'module'}`;
    const nativeCase = nativeProof.watCases.find(entry => entry.id === id);
    assert.equal(nativeCase.status, 'passed');
    assert.deepEqual(nativeCase.fixture, identity(Buffer.from(fixture.wat)));
    const result = await inWorker({ wat: fixture.wat, relocatable, flags: fixture.flags });
    assert.equal(result.error, undefined, `${id}: ${result.error}`);
    assert.equal(result.status, fixture.reject ? 1 : 0, `${id}: ${result.diagnostics.join('\n')}`);
    const entry = { id, status: 'passed', diagnostics: result.diagnostics };
    if (fixture.reject) { assert.equal(result.bytes, null); assert.match(result.diagnostics.join('\n'), /target_features:/); }
    else {
      const bytes = Buffer.from(result.bytes), reference = await readInput(nativeCase.object.path);
      assert.deepEqual(bytes, reference, `${id}: native and Worker objects differ`);
      assert.deepEqual(identity(bytes), { bytes: nativeCase.object.bytes, sha256: nativeCase.object.sha256 });
      const metadata = inspectTargetFeatures(bytes); assert.deepEqual(metadata.features, fixture.features);
      entry.object = { ...identity(bytes), ...metadata }; entry.nativeObjectIdentical = true;
      const program = nativeCase.linked ? await readInput(resolve(dirname(nativeCase.object.path), 'linked.wasm')) : bytes;
      if (nativeCase.linked) assert.deepEqual(identity(program), { bytes: nativeCase.linked.bytes, sha256: nativeCase.linked.sha256 });
      const execution = await inWorker({ program: [...program] });
      assert.equal(execution.error, undefined, `${id}: ${execution.error}`);
      assert.equal(execution.valid, true); assert.equal(execution.result, fixture.result);
      entry.execution = execution; entry.program = identity(program);
      if (nativeCase.linkerLimitation) entry.linkerLimitation = nativeCase.linkerLimitation;
    }
    report.cases.push(entry);
  }
  for (const [file, expected] of inputs) assert.deepEqual(identity(await readFile(file)), expected, `Input changed: ${file}`);
  report.inputsUnchanged = true; report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  await rm(temporary, { recursive: true, force: true });
}
report.inputs = Object.fromEntries(inputs);
if (options.output) await writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: report.status, browser: report.browser, execution: report.execution,
  cases: report.cases.length, error: report.error, output: options.output }, null, 2));
