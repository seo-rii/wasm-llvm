import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';

const [runtime, output, playwrightFrom] = process.argv.slice(2);
assert(runtime && output && playwrightFrom, 'Usage: measure-browser.mjs RUNTIME NEW_REPORT PLAYWRIGHT_PACKAGE_JSON');
const root = path.resolve(runtime), assets = new Map(), inputs = [], cases = [];
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
for (const [family, module, functions] of [
  ['string-contract', 'attachments', [['attachmentSnapshot', 'original-observations.txt'], ['requiredSnapshot', 'required-boundary-observations.txt']]],
  ['exception-algorithms', 'exceptions', [['exceptionSnapshot', 'original-observations.txt'], ['uninstalledExceptionSnapshot', 'required-boundary-observations.txt']]],
  ['platform-policy', 'policy', [['policySnapshot', 'wasm-observations.txt'], ['requestPolicySnapshot', 'host-jvm-observations.txt']]],
]) {
  const filename = path.join(root, family, 'result.json'), reportBytes = await readRegular(filename);
  inputs.push({ filename, ...identity(reportBytes) });
  const report = JSON.parse(reportBytes);
  assert.equal(report.result, 'pass');
  for (const pin of report.artifacts.filter(pin => pin.filename.startsWith(path.join(root, family, 'wasm') + path.sep))) {
    const bytes = await readRegular(pin.filename);
    assert.deepEqual(identity(bytes), { bytes: pin.bytes, sha256: pin.sha256 });
    inputs.push(pin);
    assets.set('/' + path.relative(root, pin.filename).split(path.sep).join('/'), bytes);
  }
  const expected = {};
  for (const [name, file] of functions) {
    const filename = path.join(root, family, file), bytes = await readRegular(filename);
    inputs.push({ filename, ...identity(bytes) });
    expected[name] = bytes.toString();
  }
  cases.push({ family, module: `/${family}/wasm/${module}.mjs`, expected });
}
const { chromium } = createRequire(path.resolve(playwrightFrom))('playwright-core');
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/') { response.end('<!doctype html><title>Compiler exception contract</title>'); return; }
  const bytes = assets.get(pathname);
  if (!bytes) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
  response.end(bytes);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(origin);
  for (const fixture of cases) {
    fixture.actual = await page.evaluate(async ({ url, names }) => {
      const text = `import * as value from ${JSON.stringify(url)}; const result={}; for(const name of ${JSON.stringify(names)}) result[name]=value[name](); postMessage(result);`;
      const blob = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
      const worker = new Worker(blob, { type: 'module' });
      try {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Exception Worker timed out')), 30000);
          worker.onmessage = event => { clearTimeout(timer); resolve(event.data); };
          worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
        });
      } finally { worker.terminate(); URL.revokeObjectURL(blob); }
    }, { url: origin + fixture.module, names: Object.keys(fixture.expected) });
    assert.deepEqual(fixture.actual, fixture.expected);
  }
  for (const pin of inputs) assert.deepEqual(identity(await readRegular(pin.filename)), { bytes: pin.bytes, sha256: pin.sha256 });
  await writeJson(path.resolve(output), { schemaVersion: 1, kind: 'compiler-exception-chromium-worker-contract',
    status: 'passed', browser: browser.version(), engine: 'chromium', inputs, cases,
    network: 'loopback assets only', compilerExecuted: false, browserFatalTaxonomyImplemented: false });
  console.log(JSON.stringify({ status: 'passed', workers: cases.length, observations: 6, browser: browser.version() }));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
