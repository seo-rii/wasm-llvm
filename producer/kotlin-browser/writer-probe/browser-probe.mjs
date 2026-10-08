#!/usr/bin/env node
/** Runs the compiled official writer unit in a real Chromium module Worker. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const options = {};
const argumentsList = process.argv.slice(2);
while (argumentsList.length) {
  const key = argumentsList.shift();
  assert(['--output', '--evidence', '--playwright-from'].includes(key) && argumentsList[0] && !options[key], 'Invalid browser option');
  options[key] = path.resolve(argumentsList.shift());
}
const output = options['--output'] ?? path.resolve(here, '../../../out/kotlin-bytewriter-probe');
const evidencePath = options['--evidence'] ?? path.join(output, 'writer-browser.json');
const { chromium } = createRequire(options['--playwright-from'] ?? path.resolve(here, '../../../../wasm-idle/package.json'))('playwright-core');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const buildBytes = await readFile(path.join(output, 'build-receipt.json'));
const build = JSON.parse(buildBytes);
assert.equal(build.status, 'passed');
assert.equal(build.sourceLockSha256, hash(await readFile(path.join(here, 'sources.lock.json'))));
assert.equal(build.buildScriptSha256, hash(await readFile(path.join(here, 'build.mjs'))));
assert.equal(build.patch.sha256, hash(await readFile(path.join(here, build.patch.path))));
for (const record of build.observerSources) assert.equal(record.sha256, hash(await readFile(path.join(here, record.path))), 'Observer source changed after build');
const assets = new Map();
for (const record of build.outputs) {
  const bytes = await readFile(path.join(output, record.path));
  assert.equal(bytes.byteLength, record.bytes);
  assert.equal(hash(bytes), record.sha256, 'Build output changed: ' + record.path);
  if (record.path.startsWith('wasm/')) assets.set(path.basename(record.path), bytes);
}
assert(assets.has('writer-probe.mjs') && assets.has('writer-probe.wasm'));
const original = JSON.parse(await readFile(path.join(output, 'original-jvm.json')));
const portable = JSON.parse(await readFile(path.join(output, 'portable-jvm.json')));
const checks = JSON.parse(await readFile(path.join(output, 'portable-checks-jvm.json')));
assert.deepEqual(original, portable);
// Hand-checked examples also prevent a common observation mistake from becoming a differential pass.
const expectedExamples = {
  'uleb-0': '00', 'uleb-127': '7f', 'uleb-128': '8001', 'uleb-4294967295': 'ffffffff0f',
  'fixed-uleb-0': '8080808000', 'fixed-uleb-4294967295': 'ffffffff0f',
  'sleb64--64': '40', 'sleb64-63': '3f', 'sleb64-64': 'c000',
  'sleb64--9223372036854775808': '8080808080808080807f', 'sleb64-9223372036854775807': 'ffffffffffffffffff00',
  'float-bits-2147483648': '00000080', 'float-bits-2139095041': '0100807f',
  'double-bits-9221120237041095220': '341200000000f87f',
  'backpatch-extends': '01020300000000003412', 'snapshot-before-growth': 'ab0203', 'snapshot-after-growth': 'ab0203',
};
for (const [id, hex] of Object.entries(expectedExamples)) assert.equal(original.cases.find((record) => record.id === id)?.hex, hex, 'Expected example mismatch: ' + id);

const origin = 'https://kotlin-bytewriter-probe.invalid';
const workerSource = `
import { writerProbeSnapshot, writerProbePortableChecks } from '${origin}/assets/writer-probe.mjs';
self.onmessage = () => {
  try {
    const start = performance.now();
    const snapshot = JSON.parse(writerProbeSnapshot());
    const checks = JSON.parse(writerProbePortableChecks());
    const repeated = JSON.parse(writerProbeSnapshot());
    self.postMessage({ kind: 'observed', snapshot, checks, repeated, elapsedMs: performance.now() - start });
  } catch (error) { self.postMessage({ kind: 'fatal', message: String(error) }); }
};
self.postMessage({ kind: 'ready' });
`;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const assetRequests = [];
  const externalRequests = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === '/') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Official Kotlin byte writer unit</title>' });
      return;
    }
    const name = url.pathname.startsWith('/assets/') ? url.pathname.slice('/assets/'.length) : null;
    if (url.origin === origin && assets.has(name)) {
      assetRequests.push(name);
      await route.fulfill({ status: 200, contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: assets.get(name) });
      return;
    }
    externalRequests.push(route.request().url());
    await route.abort();
  });
  const page = await context.newPage();
  await page.goto(origin);
  await page.evaluate(async (source) => {
    window.writerWorkerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    window.writerWorker = new Worker(window.writerWorkerUrl, { type: 'module' });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { window.writerWorker.terminate(); reject(new Error('Writer Worker initialization timed out')); }, 30000);
      window.writerWorker.onerror = (event) => { clearTimeout(timeout); window.writerWorker.terminate(); reject(new Error(event.message)); };
      window.writerWorker.onmessage = ({ data }) => {
        clearTimeout(timeout);
        if (data.kind === 'ready') resolve();
        else { window.writerWorker.terminate(); reject(new Error(data.message ?? 'Unexpected writer initialization message')); }
      };
    });
  }, workerSource);
  await context.setOffline(true);
  const requestsDuringProbe = [];
  const onRequest = (request) => requestsDuringProbe.push(request.url());
  context.on('request', onRequest);
  let observed;
  try {
    observed = await page.evaluate(async () => {
      try {
        return await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { window.writerWorker.terminate(); reject(new Error('Writer unit execution timed out')); }, 30000);
          window.writerWorker.onerror = (event) => { clearTimeout(timeout); reject(new Error(event.message)); };
          window.writerWorker.onmessage = ({ data }) => {
            clearTimeout(timeout);
            if (data.kind === 'observed') resolve(data);
            else reject(new Error(data.message ?? 'Unexpected writer result'));
          };
          window.writerWorker.postMessage({ kind: 'observe' });
        });
      } finally {
        window.writerWorker.terminate();
        URL.revokeObjectURL(window.writerWorkerUrl);
      }
    });
  } finally { context.off('request', onRequest); }
  assert.deepEqual(requestsDuringProbe, []);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(observed.snapshot, original, 'WasmJs official writer differs from original JVM writer');
  assert.deepEqual(observed.repeated, original, 'Repeated WasmJs writer invocation changed bytes');
  assert.deepEqual(observed.checks, checks, 'Portable sink guards differ between JVM and WasmJs');
  const cases = original.cases.map((record, index) => {
    const bytes = Buffer.from(record.hex, 'hex');
    const browserBytes = Buffer.from(observed.snapshot.cases[index].hex, 'hex');
    return { id: record.id, category: record.category, bytes: record.bytes, originalJvmSha256: hash(bytes),
      portableJvmSha256: hash(Buffer.from(portable.cases[index].hex, 'hex')), browserWasmSha256: hash(browserBytes), byteEquivalent: true };
  });
  const evidence = {
    schemaVersion: 1, kind: 'official-byte-writer-jvm-wasmjs-unit-comparison', gate: 'G2-writer-unit-only', status: 'passed',
    source: build.source, sourceLockSha256: build.sourceLockSha256, patch: build.patch, sourceVerification: build.sourceVerification,
    observerSources: build.observerSources, buildScriptSha256: build.buildScriptSha256,
    buildReceiptSha256: hash(buildBytes), browserProbeSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    bootstrapLockSha256: build.bootstrapLockSha256, bootstrapVersion: build.bootstrapVersion,
    bootstrapCompilerSourceCommit: build.bootstrapCompilerSourceCommit, bootstrapArtifacts: build.bootstrapArtifacts,
    buildCommands: build.commands, browserCommand: [process.execPath, ...process.argv.slice(1)], java: build.java,
    environment: { ...build.environment, browser: 'Chromium', browserVersion: browser.version(), headless: true, browserFlags: [] },
    outputs: build.outputs, network: { offlineAfterInitialization: true, requestsDuringProbe, externalRequests,
      localStaticAssetRequests: assetRequests, assetDelivery: 'Playwright fulfillment from hash-verified prepared files' },
    corpus: { required: cases.length, passed: cases.length, failed: 0, skipped: 0, notRun: 0 }, cases,
    independentExamples: { required: Object.keys(expectedExamples).length, passed: Object.keys(expectedExamples).length, expectedHex: expectedExamples },
    checks: original.checks, portableGuards: checks, fileAdapterByteEquality: true, repeatedBrowserInvocationByteEquality: true,
    browserProbeElapsedMs: observed.elapsedMs, languageReadiness: false,
    limitations: [...build.limitations.filter((item) => !item.startsWith('A successful build')),
      'Only the listed writer unit corpus ran. This does not complete the whole G2 gate or provide a browser Kotlin compiler.',
      'Only this Chromium configuration was tested. No browser matrix, performance target or GC heap hard cap is claimed.',
      'Offline applies after static loader/Wasm initialization; app-shell restart, asset cache persistence and offline compiler loading were not tested.'],
  };
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ evidence: evidencePath, status: evidence.status, cases: evidence.corpus, guards: checks.passed.length, browser: browser.version() }));
} finally { await browser.close(); }
