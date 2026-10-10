import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

export async function observeBrowser({ modules, wasm, cases }) {
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext(), requests = [], pageErrors = [];
        await context.route('https://kotlin-console-runtime.invalid/', route => route.fulfill({
            contentType: 'text/html', body: '<!doctype html><title>Kotlin console runtime corpus</title>',
        }));
        const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(String(error)));
        await page.goto('https://kotlin-console-runtime.invalid/');
        await context.setOffline(true); context.on('request', request => requests.push(request.url()));
        const results = await page.evaluate(async ({ modules, binary, cases }) => {
            const urls = [];
            const moduleUrl = code => { const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); urls.push(url); return url; };
            const wasi = moduleUrl(modules.wasi), program = moduleUrl(modules.program.replace("from './wasi.js'", `from '${wasi}'`));
            const workerUrl = moduleUrl(modules['program.worker'].replace("from './program.js'", `from '${program}'`));
            const observations = [];
            try {
                for (const [generation, test] of cases.entries()) {
                    const worker = new Worker(workerUrl, { type: 'module' }), requestId = 'console-' + generation;
                    let heartbeats = 0; const heartbeat = setInterval(() => heartbeats++, 1), started = performance.now();
                    try {
                        const result = await new Promise((resolve, reject) => {
                            const deadline = setTimeout(() => reject(new Error('Console Worker deadline')), 30000);
                            worker.onerror = event => { clearTimeout(deadline); reject(new Error(event.message)); };
                            worker.onmessage = ({ data }) => {
                                if (data.fatal) { clearTimeout(deadline); reject(new Error(data.fatal)); return; }
                                if (data.requestId !== requestId || data.generation !== generation) return;
                                clearTimeout(deadline); resolve(data.result);
                            };
                            const bytes = new Uint8Array(binary).buffer;
                            worker.postMessage({ requestId, generation, bytes, stdin: new Uint8Array(test.stdin), maxOutputBytes: test.maxOutputBytes }, [bytes]);
                        });
                        observations.push({ id: test.id, result, heartbeats, elapsedMs: performance.now() - started });
                    } finally { clearInterval(heartbeat); worker.terminate(); }
                }
            } finally { for (const url of urls) URL.revokeObjectURL(url); }
            return observations;
        }, { modules, binary: Array.from(wasm), cases });
        assert.deepEqual(requests, []); assert.deepEqual(pageErrors, []);
        return { results, browser: { engine: 'Chromium', version: browser.version(), offlineBeforeWorkers: true,
            freshWorkers: cases.length, requests, pageErrors, rawConsumerWorker: true } };
    } finally { await browser.close(); }
}
