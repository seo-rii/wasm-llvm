import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readRegular } from '../../scripts/source.mjs';

/** Execute the unmodified, transpiled consumer in fresh offline module Workers. */
export async function observeMainEntriesInChromium({ chromium, executablePath, modules, cases, temporaryRoot }) {
  const previous = process.env.TMPDIR; process.env.TMPDIR = temporaryRoot;
  let server;
  try { server = await chromium.launchServer({ headless: true, executablePath, env: { ...process.env, TMPDIR: temporaryRoot } }); }
  finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
  const child = server.process(), exited = once(child, 'exit'), command = [...child.spawnargs];
  let report;
  try {
    const browser = await chromium.connect(server.wsEndpoint()), context = await browser.newContext();
    const requests = [], pageErrors = [], external = [];
    await context.route('**/*', route => {
      if (route.request().url() === 'https://official-main-runtime.invalid/')
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Official Kotlin main runtime</title>' });
      external.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(String(error)));
    await page.goto('https://official-main-runtime.invalid/'); await context.setOffline(true);
    context.on('request', request => requests.push(request.url()));
    await page.evaluate(modules => {
      const urls = [], make = code => { const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); urls.push(url); return url; };
      const wasi = make(modules.wasi), program = make(modules.program.replace("from './wasi.js'", `from '${wasi}'`));
      const workerUrl = make(modules['program.worker'].replace("from './program.js'", `from '${program}'`));
      globalThis.officialMainObserver = { urls, workerUrl };
    }, modules);
    const results = [];
    for (const [generation, test] of cases.entries()) {
      // Playwright serializes every numeric array element separately. Transfer
      // one compact binary string at a time, then decode inside the page.
      const binary = (await readRegular(test.filename, 8388608)).toString('base64');
      const result = await page.evaluate(async ({ generation, test, binary }) => {
          const { workerUrl } = globalThis.officialMainObserver;
          const worker = new Worker(workerUrl, { type: 'module' }), requestId = 'official-main-' + generation;
          let heartbeats = 0; const heartbeat = setInterval(() => heartbeats++, 1), started = performance.now();
          try {
            const result = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => { worker.terminate(); reject(new Error('Main Worker execution deadline')); }, 30000);
              worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
              worker.onmessage = ({ data }) => {
                if (data.fatal) { clearTimeout(timer); reject(new Error(data.fatal)); return; }
                if (data.requestId !== requestId || data.generation !== generation) return;
                clearTimeout(timer); resolve(data.result);
              };
              const decoded = atob(binary), view = new Uint8Array(decoded.length);
              for (let index = 0; index < decoded.length; index++) view[index] = decoded.charCodeAt(index);
              const bytes = view.buffer;
              worker.postMessage({ requestId, generation, bytes, stdin: new Uint8Array(test.stdin), maxOutputBytes: 1048576 }, [bytes]);
            });
            return { id: test.id, result, heartbeats, elapsedMs: performance.now() - started };
          } finally { clearInterval(heartbeat); worker.terminate(); }
      }, { generation, test: { id: test.id, stdin: test.stdin }, binary });
      results.push(result);
    }
    await page.evaluate(() => { for (const url of globalThis.officialMainObserver.urls) URL.revokeObjectURL(url); });
    assert.deepEqual(requests, []); assert.deepEqual(external, []); assert.deepEqual(pageErrors, []);
    report = { results, engine: 'Chromium', version: browser.version(), executablePath, temporaryRoot,
      offlineBeforeWorkers: true, freshWorkers: cases.length, requests, external, pageErrors,
      binaryTransfer: 'one artifact per message, base64 decoded before transfer to the unchanged Worker',
      consumerSourceUnmodified: true, importUrlsReboundToExactTranspiledModules: true };
  } finally { await server.close(); }
  const [exitCode, signal] = await exited; assert.equal(exitCode, 0); assert.equal(signal, null);
  return { ...report, process: { command, pid: child.pid, exitCode, signal } };
}
