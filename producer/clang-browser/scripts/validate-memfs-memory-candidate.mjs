import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { runMemfsMemoryProbe } from './memfs-memory-probe.mjs';

const directory = path.resolve(process.argv[2] || 'out/memfs-memory');
const receipt = JSON.parse(await fs.readFile(path.join(directory, 'candidate-receipt.json'), 'utf8'));
const inputs = {};
for (const name of ['baseline', 'candidate', 'baseline-instrumented', 'candidate-instrumented']) {
  const bytes = await fs.readFile(path.join(directory, name, 'memfs.wasm'));
  const expected = name === 'baseline' ? receipt.baseline.outputs['memfs.wasm'] : receipt.outputs[name].wasm;
  assert.equal(bytes.length, expected.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
  inputs[name] = { bytes: Array.from(bytes), mode: name === 'baseline' ? 'baseline' : name.endsWith('-instrumented') ? 'counters' : 'candidate' };
}
const report = { format: 'wasm-llvm-memfs-memory-validation-v1',
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  node: process.version, receiptSha256: createHash('sha256').update(await fs.readFile(path.join(directory, 'candidate-receipt.json'))).digest('hex'),
  results: {}, passed: false, scope: 'actual MemFS Wasm in Node and Chromium Worker; not the full Clang product or a timing benchmark' };
let browser;
try {
  for (const [name, input] of Object.entries(inputs)) report.results[`node/${name}`] = await runMemfsMemoryProbe(input);
  browser = await chromium.launch({ headless: true });
  report.browser = browser.version();
  const page = await browser.newPage();
  for (const [name, input] of Object.entries(inputs)) {
    report.results[`chromium-worker/${name}`] = await page.evaluate(async ({ source, input }) => {
      const url = URL.createObjectURL(new Blob([
        `self.onmessage = async (event) => { try { self.postMessage({result: await (${source})(event.data)}); } catch (error) { self.postMessage({error: String(error.stack || error)}); } };`
      ], { type: 'text/javascript' }));
      const worker = new Worker(url);
      try {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('MemFS Worker watchdog expired')), 30000);
          worker.onmessage = ({ data }) => { clearTimeout(timer); data.error ? reject(new Error(data.error)) : resolve(data.result); };
          worker.onerror = (event) => { clearTimeout(timer); reject(new Error(event.message)); };
          worker.postMessage(input);
        });
      } finally { worker.terminate(); URL.revokeObjectURL(url); }
    }, { source: runMemfsMemoryProbe.toString(), input });
  }
  for (const environment of ['node', 'chromium-worker']) {
    const baseline = report.results[`${environment}/baseline`];
    assert.equal(baseline.results.length, 1);
    assert.equal(baseline.results[0].passed, false, 'pinned baseline must reproduce the short-read defect');
    assert.match(baseline.results[0].error, /requested read count: 6 != 1/);
    for (const variant of ['candidate', 'baseline-instrumented', 'candidate-instrumented']) {
      for (const result of report.results[`${environment}/${variant}`].results) assert.equal(result.passed, true, `${environment}/${variant}/${result.name}: ${result.error}`);
    }
    const before = report.results[`${environment}/baseline-instrumented`].metrics;
    const after = report.results[`${environment}/candidate-instrumented`].metrics;
    assert.equal(before.freshWriteZeroedBytes, 65536);
    assert.equal(after.freshWriteZeroedBytes, 0);
    assert.equal(before.gapWriteZeroedBytes, 65535);
    assert.equal(after.gapWriteZeroedBytes, 65534);
  }
  report.passed = true;
} catch (error) {
  report.error = String(error?.stack || error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await fs.writeFile(path.join(directory, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('MEMFS_VALIDATION ' + JSON.stringify(report));
}
