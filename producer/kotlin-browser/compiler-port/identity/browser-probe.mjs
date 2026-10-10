#!/usr/bin/env node
/** Executes the real common index/official SmartIdentityTable in an offline Chromium Worker. */
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
    assert(['--output-root', '--evidence', '--playwright-from'].includes(args[index]) && args[index + 1] && !options[args[index]], 'Invalid identity browser option');
    options[args[index]] = path.resolve(args[index + 1]);
}
const output = options['--output-root'] ?? path.join(REPO, 'out/kotlin-identity-probe');
const evidencePath = options['--evidence'] ?? path.join(output, 'browser-receipt.json');
const { chromium } = createRequire(options['--playwright-from'] ?? path.resolve(REPO, '../wasm-idle/package.json'))('playwright-core');
const buildBytes = await readRegular(path.join(output, 'differential-receipt.json'));
const build = JSON.parse(buildBytes);
assert.equal(build.result, 'index-pass'); assert.equal(build.comparison.failed, 0); assert.equal(build.comparison.notRun, 0);
assert.equal(build.sourceLockSha256, sha256(await readRegular(path.join(HERE, 'sources.lock.json'))));
assert.equal(build.verificationToolSha256, sha256(await readRegular(path.join(HERE, 'build-probe.mjs'))));
assert.equal(build.preparation.preparationToolSha256, sha256(await readRegular(path.join(HERE, 'prepare.mjs'))));
assert.equal(build.preparation.patch.sha256, sha256(await readRegular(path.join(HERE, build.preparation.patch.path))));
assert.equal(build.preparation.adapter.sha256, sha256(await readRegular(path.join(HERE, build.preparation.adapter.path))));
assert.equal(build.hashReferenceLockSha256, sha256(await readRegular(path.join(HERE, 'hash-references.lock.json'))));
for (const pin of build.observerSources) assert.equal(sha256(await readRegular(path.join(HERE, relativePath(pin.path)))), pin.sha256);
const assets = new Map();
for (const pin of build.outputs) {
    const bytes = await readRegular(path.join(output, relativePath(pin.path)), 16 * 1024 * 1024);
    assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
    if (pin.path.startsWith('wasm/')) {
        const name = pin.path.slice('wasm/'.length); assert.equal(path.basename(name), name); assert(!assets.has(name));
        assets.set(name, bytes);
    }
}
assert(assets.has('identity-probe.mjs') && assets.has('identity-probe.wasm'));
const original = (await readRegular(path.join(output, 'original-index-observations.txt'))).toString();
assert.equal(sha256(Buffer.from(original)), build.comparison.originalSha256);
const origin = 'https://kotlin-compiler-identity-probe.invalid';
const workerSource = `
import { identityProbeSnapshot } from '${origin}/assets/identity-probe.mjs';
self.onmessage = () => {
  try {
    const started = performance.now();
    const snapshot = identityProbeSnapshot();
    const repeated = identityProbeSnapshot();
    self.postMessage({ kind: 'observed', snapshot, repeated, elapsedMs: performance.now() - started });
  } catch (error) { self.postMessage({ kind: 'fatal', message: String(error) }); }
};
self.postMessage({ kind: 'ready' });
`;
const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext();
    const assetRequests = [], externalRequests = [];
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === '/') {
            await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Official compiler identity unit</title>' }); return;
        }
        const name = url.pathname.startsWith('/assets/') ? url.pathname.slice('/assets/'.length) : null;
        if (url.origin === origin && assets.has(name)) {
            assetRequests.push(name);
            await route.fulfill({ status: 200, contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: assets.get(name) }); return;
        }
        externalRequests.push(route.request().url()); await route.abort();
    });
    const page = await context.newPage(); await page.goto(origin);
    await page.evaluate(async source => {
        window.identityWorkerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        window.identityWorker = new Worker(window.identityWorkerUrl, { type: 'module' });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { window.identityWorker.terminate(); reject(new Error('Identity Worker initialization timed out')); }, 30000);
            window.identityWorker.onerror = event => { clearTimeout(timer); window.identityWorker.terminate(); reject(new Error(event.message)); };
            window.identityWorker.onmessage = ({ data }) => {
                clearTimeout(timer);
                if (data.kind === 'ready') resolve();
                else { window.identityWorker.terminate(); reject(new Error(data.message ?? 'Unexpected identity initialization')); }
            };
        });
    }, workerSource);
    await context.setOffline(true);
    const requestsDuringProbe = [];
    const listener = request => requestsDuringProbe.push(request.url()); context.on('request', listener);
    let observed;
    try {
        observed = await page.evaluate(async () => {
            try {
                return await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => { window.identityWorker.terminate(); reject(new Error('Identity Worker execution timed out')); }, 30000);
                    window.identityWorker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
                    window.identityWorker.onmessage = ({ data }) => {
                        clearTimeout(timer);
                        data.kind === 'observed' ? resolve(data) : reject(new Error(data.message ?? 'Unexpected identity observation'));
                    };
                    window.identityWorker.postMessage({ kind: 'observe' });
                });
            } finally {
                window.identityWorker.terminate(); URL.revokeObjectURL(window.identityWorkerUrl);
            }
        });
    } finally { context.off('request', listener); }
    assert.deepEqual(externalRequests, []); assert.deepEqual(requestsDuringProbe, []);
    assert.equal(observed.snapshot, original, 'Chromium identity index/SmartIdentityTable differs from its original JVM reference');
    assert.equal(observed.repeated, original, 'Repeated Chromium index invocation differs');
    const receipt = { schemaVersion: 1, kind: 'official-compiler-reference-identity-chromium-comparison', result: 'pass',
        source: build.source, sourceLockSha256: build.sourceLockSha256, preparation: build.preparation,
        buildReceiptSha256: sha256(buildBytes), buildVerificationToolSha256: build.verificationToolSha256,
        browserVerificationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), observerSources: build.observerSources,
        bootstrap: build.bootstrap, outputs: build.outputs, buildCommands: build.commands, indexReuse: build.indexReuse,
        comparison: { required: build.comparison.required, passed: build.comparison.required, failed: 0, notRun: 0, skipped: 0,
            mutationOperations: build.comparison.mutationOperations, mutationSeedHex: build.comparison.mutationSeedHex,
            originalJvmSha256: sha256(Buffer.from(original)), browserWasmSha256: sha256(Buffer.from(observed.snapshot)),
            repeatedBrowserSha256: sha256(Buffer.from(observed.repeated)), cases: build.comparison.cases },
        hashAndAttributes: { ...build.hashAndAttributes, wasmExecution: 'not-run: actual FIR/IR dependency closure remains separate' },
        environment: { browser: 'Chromium', browserVersion: browser.version(), headless: true, browserFlags: [], node: process.version },
        network: { offlineAfterInitialization: true, requestsDuringProbe, externalRequests, staticAssetRequests: assetRequests,
            staticDelivery: 'Playwright fulfillment from hash-verified prepared build files' }, probeElapsedMs: observed.elapsedMs,
        limitations: [...build.limitations,
            'The offline Worker executes only the real identity unit, not the browser compiler or a user Kotlin program.',
            'Offline applies after static loader/Wasm initialization, not app-shell restart or persistent asset-cache behavior.',
            'This Chromium configuration does not establish a browser matrix, compiler product cost or total GC heap hard cap.'],
        browserCompilerBuilt: false, readiness: false };
    await writeFile(evidencePath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ evidencePath, result: receipt.result, cases: receipt.comparison.required,
        hashAndAttributes: receipt.hashAndAttributes.result, browser: browser.version(), externalRequests: externalRequests.length, readiness: false }));
} finally { await browser.close(); }
