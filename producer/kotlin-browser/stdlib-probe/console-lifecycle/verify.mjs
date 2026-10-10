import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readRegular, relativePath, sha256 } from '../../scripts/source.mjs';
import { verifyLifecycle } from './browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
function content(bytes, pin) { assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); }
const evidence = JSON.parse(await readRegular(path.join(HERE, 'evidence/receipt.json')));
const output = path.resolve(evidence.outputRoot); assert(output.startsWith(path.join(REPO, 'out') + path.sep));
const local = new Set();
for (const pin of evidence.unitFiles) {
    relativePath(pin.path); assert(!local.has(pin.path)); local.add(pin.path); content(await readRegular(path.join(HERE, pin.path)), pin);
}
assert.deepEqual([...local].sort(), ['README.md', 'browser.mjs', 'check.mjs', 'verify.mjs'].sort());
const receiptBytes = await readRegular(path.join(output, 'receipt.json')); assert.equal(sha256(receiptBytes), evidence.receiptSha256);
const receipt = JSON.parse(receiptBytes); assert.deepEqual(Object.fromEntries(Object.keys(receipt).map(key => [key, evidence[key]])), receipt);
assert.equal(receipt.kind, 'actual-kotlin-disposable-worker-lifecycle'); assert.equal(receipt.status, 'pass');
content(await readRegular(receipt.predecessor.filename), receipt.predecessor);
const predecessor = JSON.parse(await readRegular(receipt.predecessor.filename));
assert.equal(receipt.inputRoot, predecessor.outputRoot);
assert.deepEqual(receipt.program, predecessor.artifacts.find(pin => pin.path === 'program/console-runtime.wasm'));
content(await readRegular(path.join(receipt.inputRoot, receipt.program.path)), receipt.program);
await promisify(execFile)(process.execPath, [path.join(HERE, '../console-runtime/verify.mjs')], { cwd: REPO });
const artifacts = new Set();
for (const pin of receipt.artifacts) {
    relativePath(pin.path); assert(!artifacts.has(pin.path)); artifacts.add(pin.path); content(await readRegular(path.join(output, pin.path)), pin);
}
assert.deepEqual([...artifacts].sort(), ['chromium.json', 'predecessor-verification.json'].sort());
for (const pin of receipt.localTools) content(await readRegular(path.join(HERE, pin.path)), pin);
const observation = JSON.parse(await readRegular(path.join(output, 'chromium.json'))); verifyLifecycle(observation);
assert.deepEqual(observation.browser, receipt.browser); assert.equal(receipt.stoppedRequests, 3); assert.equal(receipt.observedLoopWrites, 2); assert.equal(receipt.freshRecoveries, 3);
for (const key of ['fullWasiAcceptance', 'compilerR0R1', 'browserKotlinCompilation', 'languageReadiness', 'productionCancellationController']) assert.equal(receipt[key], false);
assert.equal(receipt.hardMemoryLimit, 'not-established');
for (const pin of [evidence.execution.log, evidence.execution.status]) content(await readRegular(pin.filename), pin);
assert.equal(JSON.parse(await readRegular(evidence.execution.status.filename)).exitCode, 0);
console.log(JSON.stringify({ stoppedRequests: 3, freshRecoveries: 3, offlineWorkers: 6, productionCancellationController: false, browserKotlinCompilation: false }));
