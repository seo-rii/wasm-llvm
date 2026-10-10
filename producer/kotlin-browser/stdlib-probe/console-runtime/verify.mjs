import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, relativePath, sha256 } from '../../scripts/source.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { loadRecipe } from '../prepare.mjs';
import { validateTargetReceipt } from '../baseline.mjs';
import { cases, verifyResults } from './cases.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
function verifyContent(bytes, pin) { assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); }
const evidence = JSON.parse(await readRegular(path.join(HERE, 'evidence/receipt.json')));
const output = path.resolve(evidence.outputRoot); assert(output.startsWith(path.join(REPO, 'out') + path.sep));
const local = new Set();
for (const pin of evidence.unitFiles) {
    relativePath(pin.path); assert(!local.has(pin.path)); local.add(pin.path);
    verifyContent(await readRegular(path.join(HERE, pin.path)), pin);
}
assert.deepEqual([...local].sort(), ['ConsoleRuntime.kt', 'README.md', 'browser.mjs', 'cases.mjs', 'check.mjs', 'verify.mjs'].sort());
const receiptBytes = await readRegular(path.join(output, 'receipt.json')); assert.equal(sha256(receiptBytes), evidence.receiptSha256);
const actual = JSON.parse(receiptBytes);
assert.deepEqual(Object.fromEntries(Object.keys(actual).map(key => [key, evidence[key]])), actual);
assert.equal(actual.kind, 'actual-selected-target-kotlin-consumer-console-corpus'); assert.equal(actual.status, 'pass');
assert.equal(actual.cases, 24); assert.equal(cases.length, 24); assert.equal(actual.normalization, false);
assert.equal(actual.rawNodeEqualsChromium, true);
for (const key of ['fullWasiAcceptance', 'compilerR0R1', 'browserKotlinCompilation', 'languageReadiness']) assert.equal(actual[key], false);
assert.equal(actual.cancellation, 'not-run'); assert.equal(actual.streamingStdin, 'unsupported'); assert.equal(actual.hardMemoryLimit, 'not-established');
assert.deepEqual(actual.commands.map(row => [row.phase, row.exitCode]), [['source', 0], ['binary', 0], ['node', 0]]);
const artifacts = new Set();
for (const pin of actual.artifacts) {
    relativePath(pin.path); assert(!artifacts.has(pin.path)); artifacts.add(pin.path);
    verifyContent(await readRegular(path.join(output, pin.path), pin.bytes), pin);
}
for (const pin of actual.localTools) verifyContent(await readRegular(path.join(HERE, pin.path)), pin);
for (const pin of actual.consumerFiles) verifyContent(await readRegular(pin.filename), pin);
verifyContent(await readRegular(actual.typescript.filename, actual.typescript.bytes), actual.typescript);
const targetBytes = await readRegular(actual.stdlibBuildReceipt.filename);
assert.equal(sha256(targetBytes), actual.stdlibBuildReceipt.sha256);
const target = JSON.parse(targetBytes), recipe = await loadRecipe();
validateTargetReceipt(target, recipe, sha256(await readRegular(path.join(HERE, '../recipe.json'))));
assert.deepEqual(actual.stdlib, target.stdlib); assert.deepEqual(actual.source, recipe.source);
verifyContent(await readRegular(actual.stdlibFile, actual.stdlib.bytes), actual.stdlib);
const bootstrap = await verifyBootstrap(); assert.deepEqual(actual.compiler.artifacts, bootstrap.artifacts);
assert.equal(actual.compiler.version, bootstrap.lock.version); assert.equal(actual.compiler.sourceCommit, null);
assert.equal(actual.compiler.role, 'official-bootstrap');
const node = JSON.parse(await readRegular(path.join(output, 'node.json')));
const chromium = JSON.parse(await readRegular(path.join(output, 'chromium.json')));
verifyResults(node); verifyResults(chromium.results);
assert.deepEqual(chromium.results.map(({ id, result }) => ({ id, result })), node);
assert.deepEqual(actual.browser, chromium.browser); assert.equal(actual.browser.engine, 'Chromium');
assert.equal(actual.browser.offlineBeforeWorkers, true); assert.equal(actual.browser.freshWorkers, 24);
assert.equal(actual.browser.rawConsumerWorker, true); assert.deepEqual(actual.browser.requests, []); assert.deepEqual(actual.browser.pageErrors, []);
for (const pin of [evidence.execution.log, evidence.execution.status]) verifyContent(await readRegular(pin.filename), pin);
assert.equal(JSON.parse(await readRegular(evidence.execution.status.filename)).exitCode, 0);
console.log(JSON.stringify({ cases: 24, executions: 48, offlineWorkers: 24, artifacts: artifacts.size,
    fullWasiAcceptance: false, browserKotlinCompilation: false }));
