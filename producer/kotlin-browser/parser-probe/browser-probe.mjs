#!/usr/bin/env node
/** Differential observer only: the compiled module is the official new parser, not a compiler. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), values[index + 1]]);
  return pairs;
}, []));
const output = path.resolve(options.output ?? path.join(here, '../../../out/kotlin-parser-probe'));
const evidencePath = path.resolve(options.evidence ?? path.join(output, 'g1-parser.json'));
const consumerPackage = options['playwright-from'] ?? path.resolve(here, '../../../../wasm-idle/package.json');
const { chromium } = createRequire(consumerPackage)('playwright-core');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const build = JSON.parse(await readFile(path.join(output, 'build-receipt.json'), 'utf8'));
assert.equal(build.status, 'passed', 'Parser build must succeed before browser comparison');
assert.equal(build.recipeSha256, sha256(await readFile(path.join(here, 'recipe.json'))), 'Parser recipe changed after build');
assert.equal(build.fixturesSha256, sha256(await readFile(path.join(here, 'fixtures.json'))), 'Parser fixtures changed after build');
for (const record of build.observerSources) {
  assert.equal(record.sha256, sha256(await readFile(path.join(here, record.path))), `Observer source changed after build: ${record.path}`);
}
for (const record of build.baselineOutputs) {
  const data = await readFile(path.join(output, record.path));
  assert.equal(data.byteLength, record.bytes, `Baseline size mismatch: ${record.path}`);
  assert.equal(sha256(data), record.sha256, `Baseline digest mismatch: ${record.path}`);
}
const cases = JSON.parse(await readFile(path.join(output, 'cases.json'), 'utf8'));
const jvm = JSON.parse(await readFile(path.join(output, 'jvm-results.json'), 'utf8'));
assert.equal(cases.length, jvm.length);
const assets = new Map();
for (const record of build.outputs.filter((item) => item.path.startsWith('wasm/'))) {
  const data = await readFile(path.join(output, record.path));
  assert.equal(data.byteLength, record.bytes, `Asset size mismatch: ${record.path}`);
  assert.equal(sha256(data), record.sha256, `Asset digest mismatch: ${record.path}`);
  assets.set(path.basename(record.path), data);
}
assert(assets.has('parser-probe.mjs'), 'Generated parser loader is missing');
const origin = 'https://kotlin-parser-probe.invalid';
const workerSource = `
import * as parser from '${origin}/assets/parser-probe.mjs';
const snapshot = parser.parserSnapshot;
if (typeof snapshot !== 'function') throw new Error('Official probe export is missing');
self.onmessage = ({ data }) => {
  try {
    if (data.kind === 'cases') {
      const observed = data.cases.map(({ id, source }) => {
        const start = performance.now();
        const value = JSON.parse(snapshot(source));
        return { id, snapshot: value, elapsedMs: performance.now() - start };
      });
      self.postMessage({ kind: 'cases', observed });
    } else if (data.kind === 'stress') {
      self.postMessage({ kind: 'entered-parser' });
      snapshot(data.source);
      self.postMessage({ kind: 'stress-complete' });
    }
  } catch (error) { self.postMessage({ kind: 'fatal', error: String(error) }); }
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
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Official Kotlin parser probe</title>' });
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
  // The fixture route provides already-prepared immutable assets locally. No external server is used.
  await page.evaluate(async (source) => {
    window.probeWorkerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    window.newProbeWorker = () => new Promise((resolve, reject) => {
      const worker = new Worker(window.probeWorkerUrl, { type: 'module' });
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Parser worker initialization timed out')); }, 30000);
      worker.onerror = (event) => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)); };
      worker.onmessage = ({ data }) => {
        if (data.kind === 'ready') { clearTimeout(timeout); resolve(worker); }
        else if (data.kind === 'fatal') { clearTimeout(timeout); worker.terminate(); reject(new Error(data.error)); }
      };
    });
    window.probeWorker = await window.newProbeWorker();
  }, workerSource);
  await context.setOffline(true);
  const requestsDuringCorpus = [];
  const observeRequest = (request) => requestsDuringCorpus.push(request.url());
  context.on('request', observeRequest);
  let observed;
  try {
    observed = await page.evaluate(async (cases) => {
      let heartbeatTicks = 0;
      const heartbeat = setInterval(() => heartbeatTicks++, 10);
      try {
        const result = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { window.probeWorker.terminate(); reject(new Error('Parser corpus timed out')); }, 30000);
          window.probeWorker.onerror = (event) => { clearTimeout(timeout); reject(new Error(event.message)); };
          window.probeWorker.onmessage = ({ data }) => {
            clearTimeout(timeout);
            if (data.kind === 'cases') resolve(data.observed);
            else reject(new Error(data.error ?? 'Unexpected parser worker message'));
          };
          window.probeWorker.postMessage({ kind: 'cases', cases });
        });
        return { cases: result, heartbeatTicks };
      } finally { clearInterval(heartbeat); window.probeWorker.terminate(); }
    }, cases.map(({ id, source }) => ({ id, source })));
  } finally { context.off('request', observeRequest); }
  assert.deepEqual(requestsDuringCorpus, [], 'Parsing requested assets or external networking after initialization');
  const comparisons = [];
  for (const [index, item] of observed.cases.entries()) {
    assert.equal(item.id, cases[index].id);
    const snapshot = item.snapshot;
    let difference = null;
    try { assert.deepEqual(snapshot, jvm[index]); } catch (error) { difference = String(error.message).slice(0, 2000); }
    const errors = snapshot.markers.filter((marker) => marker[0] === 'error');
    comparisons.push({
      id: item.id,
      category: cases[index].category,
      sourceSha256: cases[index].sourceSha256,
      sourceBytes: cases[index].sourceBytes,
      sourceUtf16: cases[index].sourceUtf16,
      tokenCount: snapshot.tokens.length,
      markerCount: snapshot.markers.length,
      syntaxErrors: errors.map((marker) => ({ type: marker[1], startUtf16: marker[2], endUtf16: marker[3], message: marker[6] })),
      expectationMatched: Boolean(errors.length) === cases[index].expectSyntaxError,
      hostEquivalent: difference === null,
      difference,
      jvmSnapshotSha256: sha256(JSON.stringify(jvm[index])),
      browserSnapshotSha256: sha256(JSON.stringify(snapshot)),
      browserElapsedMs: item.elapsedMs,
    });
  }
  // Fresh workers may fetch the already-prepared local fixture assets. This does not claim offline app-shell restart.
  const cancellation = await page.evaluate(async ({ cases }) => {
    const worker = await window.newProbeWorker();
    const stressSource = Array.from({ length: 100000 }, (_, index) => 'val stress_' + index + ' = ' + index + '\n').join('');
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Parser stress request never entered')); }, 10000);
      let completedBeforeTermination = false;
      worker.onerror = (event) => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)); };
      worker.onmessage = ({ data }) => {
        if (data.kind === 'entered-parser') {
          const start = performance.now();
          setTimeout(() => {
            clearTimeout(timeout);
            worker.terminate();
            resolve({ sourceUtf16: stressSource.length, completedBeforeTermination, terminationElapsedMs: performance.now() - start });
          }, 20);
        } else if (data.kind === 'stress-complete') completedBeforeTermination = true;
        else if (data.kind === 'fatal') { clearTimeout(timeout); worker.terminate(); reject(new Error(data.error)); }
      };
      worker.postMessage({ kind: 'stress', source: stressSource });
    });
    const fresh = await window.newProbeWorker();
    const recovered = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { fresh.terminate(); reject(new Error('Fresh parser recovery timed out')); }, 10000);
      fresh.onerror = (event) => { clearTimeout(timeout); fresh.terminate(); reject(new Error(event.message)); };
      fresh.onmessage = ({ data }) => {
        clearTimeout(timeout);
        fresh.terminate();
        if (data.kind === 'cases') resolve(data.observed[0].snapshot);
        else reject(new Error(data.error ?? 'Unexpected recovery response'));
      };
      fresh.postMessage({ kind: 'cases', cases: [cases[0]] });
    });
    URL.revokeObjectURL(window.probeWorkerUrl);
    return { ...result, recovered };
  }, { cases: cases.map(({ id, source }) => ({ id, source })) });
  assert.equal(cancellation.completedBeforeTermination, false, 'Stress parser completed before external termination');
  assert.deepEqual(cancellation.recovered, jvm[0], 'Fresh parser did not recover after termination');
  assert.deepEqual(externalRequests, []);
  const passed = comparisons.every((item) => item.hostEquivalent && item.expectationMatched);
  const evidence = {
    schemaVersion: 1,
    kind: 'official-new-parser-jvm-wasmjs-comparison',
    gate: 'G1',
    status: passed ? 'passed' : 'failed',
    source: build.source,
    recipeSha256: build.recipeSha256,
    bootstrapLockSha256: build.bootstrapLockSha256,
    bootstrapVersion: build.bootstrapVersion,
    bootstrapCompilerSourceCommit: build.bootstrapCompilerSourceCommit,
    observerSources: build.observerSources,
    fixturesSha256: build.fixturesSha256,
    baselineOutputs: build.baselineOutputs,
    buildCommands: build.commands,
    browserCommand: [process.execPath, ...process.argv.slice(1)],
    browserProbeSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    buildReceiptSha256: sha256(await readFile(path.join(output, 'build-receipt.json'))),
    java: build.java,
    environment: { os: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, browser: 'Chromium', browserVersion: browser.version(), headless: true, browserFlags: [] },
    outputs: build.outputs,
    network: { offlineAfterInitialization: true, requestsDuringCorpus, externalRequests, localStaticAssetRequests: assetRequests, assetDelivery: 'Playwright fulfillment from hash-verified prepared files' },
    corpus: { required: comparisons.length, passed: comparisons.filter((item) => item.hostEquivalent && item.expectationMatched).length, failed: comparisons.filter((item) => !item.hostEquivalent || !item.expectationMatched).length, skipped: 0, notRun: 0 },
    cases: comparisons,
    mainThreadHeartbeatTicks: observed.heartbeatTicks,
    cancellation: { requestEntered: true, externalWorkerTermination: true, completedBeforeTermination: cancellation.completedBeforeTermination, sourceUtf16: cancellation.sourceUtf16, terminationElapsedMs: cancellation.terminationElapsedMs, freshWorkerRecovered: true },
    limitations: [
      'Compares the same official new parser on JVM and wasmJs; does not compare old parser semantics.',
      'No FIR, resolution, common/target checker, IR, KLIB semantic reader, or full compiler port was executed.',
      'Error production messages/ranges are parser observations, not compiler diagnostic acceptance.',
      'Static fixture assets were provided locally; offline app-shell/cache restart is not tested.',
      'Only this Chromium configuration was tested. No GC/JS heap hard cap or performance target is claimed.',
    ],
    languageReadiness: false,
  };
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ evidence: evidencePath, status: evidence.status, corpus: evidence.corpus, browser: evidence.environment.browserVersion }));
  if (!passed) process.exitCode = 1;
} finally { await browser.close(); }
