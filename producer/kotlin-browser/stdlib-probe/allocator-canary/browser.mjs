import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

export async function observeInChromium(hostSource, wasm) {
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext(), unexpected = [], offlineRequests = [], pageErrors = [];
        const origin = 'https://kotlin-allocator-canary.invalid';
        await context.route('**/*', route => {
            const url = route.request().url();
            if (url === origin + '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Kotlin allocator observation</title>' });
            if (url === origin + '/host.mjs') return route.fulfill({ contentType: 'text/javascript', body: hostSource });
            unexpected.push(url); return route.abort();
        });
        const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(String(error)));
        await page.goto(origin);
        await page.evaluate(async origin => {
            const source = `import {observeAllocatorCanary} from '${origin}/host.mjs';
                onmessage=async({data})=>{try{postMessage({value:await observeAllocatorCanary(new Uint8Array(data))});}
                    catch(error){postMessage({error:String(error),stack:error?.stack});}};postMessage({ready:true});`;
            const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
            window.probeWorkers = [];
            try {
                for (let index = 0; index < 2; index++) {
                    const worker = new Worker(url, { type: 'module' }); window.probeWorkers.push(worker);
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => { worker.terminate(); reject(new Error('Worker init deadline')); }, 30000);
                        worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
                        worker.onmessage = ({ data }) => { clearTimeout(timer); data.ready ? resolve() : reject(new Error(data.error)); };
                    });
                }
            } finally { URL.revokeObjectURL(url); }
        }, origin);
        await context.setOffline(true); context.on('request', request => offlineRequests.push(request.url()));
        const observations = await page.evaluate(async binary => {
            const results = [];
            for (const worker of window.probeWorkers) results.push(await new Promise((resolve, reject) => {
                const timer = setTimeout(() => { worker.terminate(); reject(new Error('Allocator observation deadline')); }, 60000);
                worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
                worker.onmessage = ({ data }) => {
                    clearTimeout(timer); worker.terminate(); data.error ? reject(new Error(data.error + '\n' + data.stack)) : resolve(data.value);
                };
                worker.postMessage(binary);
            }));
            return results;
        }, Array.from(wasm));
        assert.deepEqual(observations[0], observations[1]);
        assert.deepEqual(unexpected, []); assert.deepEqual(offlineRequests, []); assert.deepEqual(pageErrors, []);
        return { observations, browser: { engine: 'Chromium', version: browser.version(), moduleWorkers: 2,
            offlineBeforeWasmCompilationAndExecution: true, externalRequests: unexpected, offlineRequests, pageErrors } };
    } finally { await browser.close(); }
}
