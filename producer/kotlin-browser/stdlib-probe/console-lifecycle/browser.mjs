import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// Observation only: delegate the real console write, then publish its accepted
// bytes. It neither supplies an import nor replaces any program/console logic.
export const writeObserver = `
const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = async function(module, imports) {
    let memory;
    const wasi = imports.wasi_snapshot_preview1, fdWrite = wasi.fd_write;
    const observedImports = { ...imports, wasi_snapshot_preview1: { ...wasi,
        fd_write(...args) {
            const result = Reflect.apply(fdWrite, wasi, args);
            if (args[0] === 1 && result === 0) {
                const view = new DataView(memory.buffer), bytes = [];
                let remaining = view.getUint32(args[3] >>> 0, true);
                const accepted = remaining;
                for (let i = 0; i < (args[2] >>> 0) && remaining > 0; i++) {
                    const base = (args[1] >>> 0) + i * 8;
                    const pointer = view.getUint32(base, true);
                    const length = Math.min(remaining, view.getUint32(base + 4, true));
                    bytes.push(...new Uint8Array(memory.buffer, pointer, length)); remaining -= length;
                }
                postMessage({ probe: 'stdout-write-accepted', result, accepted, bytes });
            }
            return result;
        }
    }};
    const instance = await Reflect.apply(instantiate, WebAssembly, [module, observedImports]);
    memory = instance.exports.memory;
    return instance;
};
`;

export async function observeLifecycle({ modules, wasm }) {
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext(), requests = [], pageErrors = [];
        await context.route('https://kotlin-console-lifecycle.invalid/', route => route.fulfill({
            contentType: 'text/html', body: '<!doctype html><title>Kotlin Worker lifecycle</title>',
        }));
        const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(String(error)));
        await page.goto('https://kotlin-console-lifecycle.invalid/');
        await context.setOffline(true); context.on('request', request => requests.push(request.url()));
        const results = await page.evaluate(async ({ modules, binary, writeObserver }) => {
            const urls = [], results = [];
            const url = code => { const value = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); urls.push(value); return value; };
            const wasi = url(modules.wasi), program = url(modules.program.replace("from './wasi.js'", `from '${wasi}'`));
            const workerSource = modules['program.worker'].replace("from './program.js'", `from '${program}'`);
            const rawWorker = url(workerSource), observedWorker = url(writeObserver + workerSource);
            let generation = 0;
            try {
                for (const mode of ['abort-after-write', 'deadline-after-write', 'raw-deadline']) {
                    const started = performance.now(), trace = [], observed = mode !== 'raw-deadline';
                    const controller = new AbortController(); let worker, deadline, abortTimer, beats = 0;
                    const heartbeat = setInterval(() => beats++, 5);
                    try {
                        const outcome = await new Promise((resolve, reject) => {
                            let settled = false;
                            const stop = reason => {
                                if (settled) return; settled = true;
                                worker?.terminate(); trace.push({ event: 'terminated', reason, elapsedMs: performance.now() - started });
                                clearTimeout(deadline); clearTimeout(abortTimer); resolve(reason);
                            };
                            // Starts before Worker construction, compilation and instantiation.
                            deadline = setTimeout(() => stop('deadline'), 1500);
                            controller.signal.addEventListener('abort', () => stop('aborted'), { once: true });
                            trace.push({ event: 'deadline-armed', milliseconds: 1500 });
                            worker = new Worker(observed ? observedWorker : rawWorker, { type: 'module' });
                            trace.push({ event: 'worker-created' });
                            worker.onerror = event => { settled = true; reject(new Error(event.message)); };
                            worker.onmessage = ({ data }) => {
                                trace.push({ event: 'message', elapsedMs: performance.now() - started, data });
                                if (data.probe === 'stdout-write-accepted') {
                                    if (mode === 'abort-after-write' && !abortTimer) abortTimer = setTimeout(() => controller.abort(), 50);
                                } else { settled = true; reject(new Error('Loop unexpectedly replied: ' + JSON.stringify(data))); }
                            };
                            const bytes = new Uint8Array(binary).buffer;
                            worker.postMessage({ requestId: 'loop-' + generation, generation: generation++, bytes,
                                stdin: new TextEncoder().encode('loop\n'), maxOutputBytes: 1024 }, [bytes]);
                        });
                        results.push({ mode, observed, outcome, heartbeats: beats, elapsedMs: performance.now() - started, trace });
                    } finally { clearTimeout(deadline); clearTimeout(abortTimer); clearInterval(heartbeat); worker?.terminate(); }
                    // Recovery always uses the unmodified consumer Worker and a fresh instance.
                    const recoveryStarted = performance.now(); let recovery, recoveryDeadline;
                    try {
                        const requestId = 'recovery-' + generation, requestGeneration = generation++;
                        const message = await new Promise((resolve, reject) => {
                            recoveryDeadline = setTimeout(() => reject(new Error('Recovery deadline')), 30000);
                            recovery = new Worker(rawWorker, { type: 'module' });
                            recovery.onerror = event => reject(new Error(event.message));
                            recovery.onmessage = ({ data }) => resolve(data);
                            const bytes = new Uint8Array(binary).buffer;
                            recovery.postMessage({ requestId, generation: requestGeneration, bytes,
                                stdin: new TextEncoder().encode('state\n'), maxOutputBytes: 1024 }, [bytes]);
                        });
                        results.push({ mode: 'recovery-after-' + mode, requestId, generation: requestGeneration,
                            message, rawConsumerWorker: true, elapsedMs: performance.now() - recoveryStarted });
                    } finally { clearTimeout(recoveryDeadline); recovery?.terminate(); }
                }
            } finally { for (const value of urls) URL.revokeObjectURL(value); }
            return results;
        }, { modules, binary: Array.from(wasm), writeObserver });
        return { results, browser: { engine: 'Chromium', version: browser.version(), offlineBeforeWorkers: true,
            freshWorkers: 6, requests, pageErrors } };
    } finally { await browser.close(); }
}

export function verifyLifecycle(observation) {
    assert.equal(observation.browser.engine, 'Chromium'); assert.equal(observation.browser.offlineBeforeWorkers, true);
    assert.equal(observation.browser.freshWorkers, 6); assert.deepEqual(observation.browser.requests, []);
    assert.deepEqual(observation.browser.pageErrors, []); assert.equal(observation.results.length, 6);
    for (const [index, mode] of ['abort-after-write', 'deadline-after-write', 'raw-deadline'].entries()) {
        const row = observation.results[index * 2], recovery = observation.results[index * 2 + 1];
        assert.equal(row.mode, mode); assert.equal(row.observed, mode !== 'raw-deadline');
        assert.equal(row.outcome, index === 0 ? 'aborted' : 'deadline'); assert(row.heartbeats > 0);
        assert.deepEqual(row.trace.slice(0, 2), [{ event: 'deadline-armed', milliseconds: 1500 }, { event: 'worker-created' }]);
        assert.equal(row.trace.at(-1).event, 'terminated'); assert.equal(row.trace.at(-1).reason, row.outcome);
        const messages = row.trace.filter(event => event.event === 'message');
        if (row.observed) {
            assert.equal(messages.length, 1);
            assert.deepEqual(messages[0].data, { probe: 'stdout-write-accepted', result: 0, accepted: 13,
                bytes: [...new TextEncoder().encode('loop-started\n')] });
            assert(messages[0].elapsedMs < row.trace.at(-1).elapsedMs);
        } else assert.deepEqual(messages, []);
        assert.equal(recovery.mode, 'recovery-after-' + mode); assert.equal(recovery.rawConsumerWorker, true);
        assert.equal(recovery.message.requestId, recovery.requestId); assert.equal(recovery.message.generation, recovery.generation);
        assert.deepEqual(recovery.message.result, { stdout: 'state:1\n', stderr: '', outputBytes: 8,
            outputLimitExceeded: false, status: 'completed', exitCode: 0 });
    }
}
