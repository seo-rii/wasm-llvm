#!/usr/bin/env node
/** Real common version algorithms in an offline Chromium module Worker. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, relativePath, sha256 } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const options = {}; const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
    assert(['--output-root', '--evidence', '--playwright-from'].includes(args[index]) && args[index + 1] && !options[args[index]]);
    options[args[index]] = path.resolve(args[index + 1]);
}
const output = options['--output-root']; assert(output && output.startsWith(path.join(REPO, 'out') + path.sep));
const receiptBytes = await readRegular(path.join(output, 'differential-receipt.json'));
const receipt = JSON.parse(receiptBytes);
assert.equal(receipt.result, 'pass'); assert.equal(receipt.comparison.originalJvmEqualsCommonJvm, true);
assert.equal(receipt.comparison.originalJvmEqualsCommonWasm, true);
assert.equal(receipt.comparison.originalPublicJavaApiEqualsCommonJvm, true);
assert.equal(receipt.sourceLockSha256, sha256(await readRegular(path.join(HERE, 'sources.lock.json'))));
assert.equal(receipt.verificationToolSha256, sha256(await readRegular(path.join(HERE, 'build-probe.mjs'))));
assert.equal(receipt.preparation.preparationToolSha256, sha256(await readRegular(path.join(HERE, 'prepare.mjs'))));
for (const pin of receipt.observerSources) assert.equal(sha256(await readRegular(path.join(HERE, relativePath(pin.path)))), pin.sha256);
const original = await readRegular(path.join(output, 'original-jvm.txt'), 16 * 1024 * 1024);
assert.equal(sha256(original), receipt.comparison.originalSha256);
const assets = new Map();
for (const pin of receipt.outputs) {
    const bytes = await readRegular(path.join(output, relativePath(pin.path)), 16 * 1024 * 1024);
    assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
    if (pin.path.startsWith('wasm/')) {
        const name = pin.path.slice(5); assert.equal(name, path.basename(name)); assert(!assets.has(name)); assets.set(name, bytes);
    }
}
assert(assets.has('compiler-versions.mjs') && assets.has('compiler-versions.wasm'));
const { chromium } = createRequire(options['--playwright-from'] ?? path.resolve(REPO, '../wasm-idle/package.json'))('playwright-core');
const origin = 'https://kotlin-version-unit.invalid';
const source = `import {versionProbeSnapshot} from '${origin}/assets/compiler-versions.mjs';
  self.onmessage = () => { try { const started = performance.now(); const snapshot = versionProbeSnapshot();
    const repeated = versionProbeSnapshot(); self.postMessage({kind:'observed',snapshot,repeated,elapsedMs:performance.now()-started});
  } catch(error) { self.postMessage({kind:'fatal',message:String(error)}); } }; self.postMessage({kind:'ready'});`;
const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext(); const staticRequests = [], externalRequests = [];
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === '/') {
            await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Official version algorithms</title>' }); return;
        }
        const name = url.pathname.startsWith('/assets/') ? url.pathname.slice(8) : null;
        if (url.origin === origin && assets.has(name)) {
            staticRequests.push(name); await route.fulfill({ status: 200, contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: assets.get(name) }); return;
        }
        externalRequests.push(route.request().url()); await route.abort();
    });
    const page = await context.newPage(); await page.goto(origin);
    await page.evaluate(async source => {
        window.versionWorkerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        window.versionWorker = new Worker(window.versionWorkerUrl, { type: 'module' });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { window.versionWorker.terminate(); reject(new Error('Version Worker initialization timed out')); }, 30000);
            window.versionWorker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
            window.versionWorker.onmessage = ({data}) => { clearTimeout(timer); data.kind === 'ready' ? resolve() : reject(new Error(data.message ?? 'Unexpected initialization')); };
        });
    }, source);
    await context.setOffline(true);
    const requestsDuringProbe = []; const onRequest = request => requestsDuringProbe.push(request.url()); context.on('request', onRequest);
    let observed;
    try {
        observed = await page.evaluate(async () => {
            try {
                return await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => { window.versionWorker.terminate(); reject(new Error('Version Worker execution timed out')); }, 30000);
                    window.versionWorker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
                    window.versionWorker.onmessage = ({data}) => { clearTimeout(timer); data.kind === 'observed' ? resolve(data) : reject(new Error(data.message ?? 'Unexpected observation')); };
                    window.versionWorker.postMessage({kind:'observe'});
                });
            } finally { window.versionWorker.terminate(); URL.revokeObjectURL(window.versionWorkerUrl); }
        });
    } finally { context.off('request', onRequest); }
    assert.equal(observed.snapshot, original.toString(), 'Chromium version algorithms differ from original JVM');
    assert.equal(observed.repeated, original.toString(), 'Repeated Chromium version state differs');
    assert.deepEqual(externalRequests, []); assert.deepEqual(requestsDuringProbe, []);
    const evidence = { schemaVersion: 1, kind: 'official-version-chromium-differential', result: 'pass',
        source: receipt.source, sourceLockSha256: receipt.sourceLockSha256, preparation: receipt.preparation,
        buildReceiptSha256: sha256(receiptBytes), buildVerificationToolSha256: receipt.verificationToolSha256,
        browserVerificationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), observerSources: receipt.observerSources,
        bootstrap: receipt.bootstrap, commands: receipt.commands, outputs: receipt.outputs,
        comparison: { ...receipt.comparison, originalJvmEqualsChromiumWasm: true, repeatedInvocationEqual: true,
            browserSha256: sha256(Buffer.from(observed.snapshot)), repeatedBrowserSha256: sha256(Buffer.from(observed.repeated)) },
        environment: { browser: 'Chromium', browserVersion: browser.version(), headless: true, browserFlags: [], node: process.version },
        network: { offlineAfterInitialization: true, staticDelivery: 'Playwright fulfillment of hash-verified genuine generated assets',
            staticRequests, requestsDuringProbe, externalRequests }, probeElapsedMs: observed.elapsedMs,
        limitations: [...receipt.limitations, 'Offline runs only this actual version-helper unit, after its static assets initialize; no browser compiler or Kotlin program is claimed.',
            'This run does not establish a browser matrix, app-shell restart, performance target or total GC heap hard cap.'],
        fullCompilerBuilt: false, freshBrowserSourceCompilation: 'not-run', readiness: false };
    const evidencePath = options['--evidence'] ?? path.join(output, 'browser-receipt.json');
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ result: 'pass', evidencePath, observations: evidence.comparison.observations, browser: browser.version(), requestsDuringProbe: 0, readiness: false }));
} finally { await browser.close(); }
