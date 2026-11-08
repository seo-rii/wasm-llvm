import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { readRegular } from '../../scripts/source.mjs';

export async function observeTowerInChromium({ chromium, executablePath, outputRoot, expected, temporaryRoot }) {
  const assets = new Map();
  for (const name of await readdir(path.join(outputRoot, 'wasm')))
    assets.set(name, await readRegular(path.join(outputRoot, 'wasm', name)));
  const origin = 'https://kotlin-tower-observer.invalid';
  const oldTemporary = process.env.TMPDIR;
  process.env.TMPDIR = temporaryRoot;
  let server;
  try { server = await chromium.launchServer({ headless: true, executablePath, env: { ...process.env, TMPDIR: temporaryRoot } }); }
  finally { if (oldTemporary === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTemporary; }
  const child = server.process();
  const exited = once(child, 'exit');
  const command = [...child.spawnargs];
  let report;
  try {
    const browser = await chromium.connect(server.wsEndpoint());
    const context = await browser.newContext();
    const externalRequests = [], assetRequests = [], offlineRequests = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin && url.pathname === '/')
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Tower map method observations</title>' });
      const name = url.pathname.slice(1);
      if (url.origin === origin && assets.has(name)) {
        assetRequests.push(name);
        return route.fulfill({ contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: assets.get(name) });
      }
      externalRequests.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(async url => {
      const source = 'import * as module from ' + JSON.stringify(url) + '; ' +
        'onmessage=()=>{try{postMessage({value:module.towerModeObservation()})}catch(error){postMessage({error:String(error)})}};postMessage({ready:true});';
      const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const worker = new Worker(blob, { type: 'module' });
      window.towerObserver = worker;
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { worker.terminate(); reject(new Error('Worker initialization deadline')); }, 30000);
          worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
          worker.onmessage = ({ data }) => { clearTimeout(timer); data.ready ? resolve() : reject(new Error(data.error)); };
        });
      } finally { URL.revokeObjectURL(blob); }
    }, origin + '/tower-mode.mjs');
    await context.setOffline(true);
    context.on('request', request => offlineRequests.push(request.url()));
    const actual = await page.evaluate(() => new Promise((resolve, reject) => {
      const worker = window.towerObserver;
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('Worker observation deadline')); }, 30000);
      worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); data.error ? reject(new Error(data.error)) : resolve(data.value); };
      worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
      worker.postMessage({ observe: true });
    }));
    assert.equal(actual, expected, 'Original JVM/offline Chromium raw observations differ');
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(offlineRequests, []);
    assert(assetRequests.includes('tower-mode.wasm'));
    report = { engine: 'Chromium', version: browser.version(), moduleWorker: true, offlineAfterInitialization: true,
      executablePath, temporaryRoot, assetRequests, externalRequests, offlineRequests, actual };
  } finally { await server.close(); }
  const [exitCode, signal] = await exited;
  assert.equal(exitCode, 0, 'Chromium process must exit successfully');
  assert.equal(signal, null);
  return { ...report, process: { command, pid: child.pid, exitCode, signal } };
}
