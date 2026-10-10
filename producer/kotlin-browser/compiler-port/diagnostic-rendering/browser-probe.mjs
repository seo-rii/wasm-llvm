#!/usr/bin/env node
/** Executes the receipt-bound formatter Wasm in an offline Chromium Worker, not a compiler. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { assertNoSymlink, readRegular, relativePath, sha256, writeJson } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');

export async function probeDiagnosticRenderingBrowser({ input, evidence } = {}) {
    assert(input, 'input required'); input = path.resolve(input);
    assert(input.startsWith(path.join(repository, 'out') + path.sep), 'Browser probe input must stay under repository out/');
    await assertNoSymlink(input);
    evidence = path.resolve(evidence ?? path.join(input, 'browser-receipt.json'));
    assert(evidence.startsWith(path.join(repository, 'out') + path.sep), 'Browser probe evidence must stay under repository out/');
    const receiptBytes = await readRegular(path.join(input, 'receipt.json'));
    const build = JSON.parse(receiptBytes);
    assert.equal(build.kind, 'pinned-openjdk-diagnostic-format-jvm-common-wasm-differential');
    assert.equal(build.recipeSha256, sha256(await readRegular(path.join(here, 'rendering.recipe.json'))), 'Rendering recipe changed after build');
    assert.equal(build.buildToolSha256, sha256(await readRegular(path.join(here, 'build-probe.mjs'))), 'Probe build tool changed after build');
    for (const observer of build.observers) assert.equal(observer.sha256, sha256(await readRegular(path.join(here, relativePath(observer.path)))), 'Observer changed after build');
    const assets = new Map();
    for (const output of build.outputs) {
        const bytes = await readRegular(path.join(input, relativePath(output.path)));
        assert.equal(bytes.length, output.bytes, 'Probe output size changed'); assert.equal(sha256(bytes), output.sha256, 'Probe output bytes changed');
        if (output.path.startsWith('wasm/')) assets.set(output.path.slice('wasm/'.length), bytes);
    }
    assert(assets.has('diagnostic-rendering.mjs'));
    const original = (await readRegular(path.join(input, 'original-jvm.txt'))).toString('utf8');
    const guards = (await readRegular(path.join(input, 'profile-guards-jvm.txt'))).toString('utf8');
    const origin = 'https://kotlin-diagnostic-format.invalid';
    const workerSource = `import * as formatter from '${origin}/assets/diagnostic-rendering.mjs';
self.onmessage = () => {
  try { self.postMessage({ observations: formatter.diagnosticFormatProbe(), guards: formatter.diagnosticProfileGuardProbe() }); }
  catch (error) { self.postMessage({ error: String(error) }); }
};
self.postMessage({ ready: true });`;
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext();
        const assetRequests = [], externalRequests = [], offlineRequests = [];
        await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.origin === origin && url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Diagnostic formatter observation</title>' });
            const name = url.pathname.startsWith('/assets/') ? url.pathname.slice('/assets/'.length) : '';
            if (url.origin === origin && assets.has(name)) {
                assetRequests.push(name);
                return route.fulfill({ status: 200, contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: assets.get(name) });
            }
            externalRequests.push(route.request().url()); return route.abort();
        });
        const page = await context.newPage(); await page.goto(origin);
        await page.evaluate(async source => {
            const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
            try {
                const worker = new Worker(url, { type: 'module' });
                window.formatterWorker = worker;
                await new Promise((resolve, reject) => {
                    const deadline = setTimeout(() => { worker.terminate(); reject(new Error('Formatter Worker initialization timed out')); }, 30000);
                    worker.onerror = event => { clearTimeout(deadline); reject(new Error(event.message)); };
                    worker.onmessage = ({ data }) => { clearTimeout(deadline); data.ready ? resolve() : reject(new Error(data.error ?? 'Unexpected initialization response')); };
                });
            } finally { URL.revokeObjectURL(url); }
        }, workerSource);
        await context.setOffline(true);
        context.on('request', request => offlineRequests.push(request.url()));
        const observed = await page.evaluate(() => new Promise((resolve, reject) => {
            const worker = window.formatterWorker;
            const deadline = setTimeout(() => { worker.terminate(); reject(new Error('Offline formatter observation timed out')); }, 30000);
            worker.onerror = event => { clearTimeout(deadline); worker.terminate(); reject(new Error(event.message)); };
            worker.onmessage = ({ data }) => { clearTimeout(deadline); worker.terminate(); data.error ? reject(new Error(data.error)) : resolve(data); };
            worker.postMessage({ observe: true });
        }));
        assert.deepEqual(externalRequests, [], 'Formatter initialization contacted an external origin');
        assert.deepEqual(offlineRequests, [], 'Formatter observation requested networking after initialization');
        assert.equal(sha256(Buffer.from(observed.observations)), sha256(Buffer.from(original)), 'Chromium Worker differs from pinned OpenJDK JVM');
        assert.equal(observed.guards, guards, 'Chromium Worker profile rejection differs from common JVM');
        const receipt = { schemaVersion: 1, kind: 'pinned-openjdk-diagnostic-format-offline-chromium-worker', source: build.source,
            buildReceiptSha256: sha256(receiptBytes), observerToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
            browser: { engine: 'Chromium', version: browser.version() }, assetRequests, externalRequests, offlineRequests,
            comparison: { observations: build.comparison.observations, literalParameterizedPatterns: build.comparison.literalParameterizedPatterns,
                rawIntDiagnosticBasePatterns: build.comparison.rawIntDiagnosticBasePatterns, originalJvmEqualsChromiumWorker: true,
                observationSha256: sha256(Buffer.from(observed.observations)), profileGuardsSha256: sha256(Buffer.from(observed.guards)),
                scope: 'Formatter module initialized before offline observation; not app-shell restart or source-to-program compiler acceptance.' },
            diagnosticTableExecution: 'not-run', resolvedFirExecution: 'not-run', fullCompilerBuilt: false, publicLanguageSupport: false };
        await writeJson(evidence, receipt);
        return { evidence, receipt };
    } finally { await browser.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = process.argv.slice(2), options = {};
        for (let index = 0; index < args.length; index += 2) {
            assert(['--input', '--evidence'].includes(args[index]) && args[index + 1] && !options[args[index]]);
            options[args[index]] = args[index + 1];
        }
        const result = await probeDiagnosticRenderingBrowser({ input: options['--input'], evidence: options['--evidence'] });
        console.log(JSON.stringify(result));
    } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
