/** Run the actual common AST observer in an offline Chromium module Worker. */
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { readRegular, sha256 } from '../../scripts/source.mjs';

export async function observeAstInChromium(outputRoot, expectedRecords) {
    const assets = new Map();
    for (const item of await readdir(path.join(outputRoot, 'wasm'), { withFileTypes: true })) {
        assert(item.isFile()); assets.set(item.name, await readRegular(path.join(outputRoot, 'wasm', item.name)));
    }
    const origin = 'https://kotlin-ast-observer.invalid';
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext(); const assetRequests = [], externalRequests = [], offlineRequests = [], pageErrors = [];
        await context.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.origin === origin && url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>AST observer</title>' });
            const name = url.pathname.startsWith('/assets/') ? url.pathname.slice(8) : '';
            if (url.origin === origin && assets.has(name)) {
                assetRequests.push(name); return route.fulfill({ status: 200, contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: assets.get(name) });
            }
            externalRequests.push(route.request().url()); return route.abort();
        });
        const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(String(error)));
        await page.goto(origin);
        await page.evaluate(async source => {
            const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
            try {
                const worker = new Worker(blobUrl, { type: 'module' }); window.astWorker = worker;
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => { worker.terminate(); reject(new Error('AST Worker initialization deadline')); }, 30000);
                    worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
                    worker.onmessage = ({ data }) => { clearTimeout(timer); data.ready ? resolve() : reject(new Error(data.error)); };
                });
            } finally { URL.revokeObjectURL(blobUrl); }
        }, `import * as ast from '${origin}/assets/js-ast.mjs';
self.onmessage=()=>{try{self.postMessage({value:ast.astProbeJson()});}catch(error){self.postMessage({error:String(error)});}};
self.postMessage({ready:true});`);
        await context.setOffline(true); context.on('request', request => offlineRequests.push(request.url()));
        const raw = await page.evaluate(() => new Promise((resolve, reject) => {
            const worker = window.astWorker;
            const timer = setTimeout(() => { worker.terminate(); reject(new Error('Offline AST observation deadline')); }, 60000);
            worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
            worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); data.error ? reject(new Error(data.error)) : resolve(data.value); };
            worker.postMessage({ observe: true });
        }));
        const observation = JSON.parse(raw);
        assert.deepEqual(observation.records, expectedRecords, 'Offline Chromium AST differs from original JVM');
        assert.deepEqual(externalRequests, []); assert.deepEqual(offlineRequests, []); assert.deepEqual(pageErrors, []);
        return { raw, observation, receipt: { engine: 'Chromium', version: browser.version(), moduleWorker: true, offlineAfterInitialization: true,
            assetRequests, externalRequests, offlineRequests, pageErrors, recordsSha256: sha256(Buffer.from(JSON.stringify(observation.records))) } };
    } finally { await browser.close(); }
}
