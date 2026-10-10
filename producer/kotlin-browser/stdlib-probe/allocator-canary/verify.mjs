import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { validateTargetReceipt } from '../baseline.mjs';
import { loadRecipe } from '../prepare.mjs';
import { readRegular, relativePath, sha256, verifyFile } from '../../scripts/source.mjs';

function verifyContent(bytes, pin) {
    assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
}

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const evidence = JSON.parse(await readRegular(path.join(HERE, 'evidence/receipt.json')));
const root = path.resolve(evidence.outputRoot); assert(root.startsWith(path.join(REPO, 'out') + path.sep));
const local = new Set();
for (const pin of evidence.unitFiles) {
    relativePath(pin.path); assert(!local.has(pin.path)); local.add(pin.path);
    verifyContent(await readRegular(path.join(HERE, pin.path)), pin);
}
assert.deepEqual([...local].sort(), ['AllocatorCanary.kt', 'README.md', 'browser.mjs', 'check.mjs', 'host.mjs', 'verify.mjs'].sort());
const receiptBytes = await readRegular(path.join(root, 'receipt.json'));
assert.equal(sha256(receiptBytes), evidence.receiptSha256);
const actual = JSON.parse(receiptBytes);
assert.deepEqual(Object.fromEntries(Object.keys(actual).map(key => [key, evidence[key]])), actual);
assert.equal(actual.kind, 'selected-source-wasi-allocator-and-poll-canaries'); assert.equal(actual.status, 'pass');
assert.equal(actual.allocations, 81); assert.equal(actual.realPatchedPollCallsPerRun, 1); assert.equal(actual.executions, 3);
assert.equal(actual.normalization, false); assert.equal(actual.rawNodeEqualsBothChromiumWorkers, true);
assert.equal(actual.originalSizeProbeIsPatchedAllocator, true);
for (const key of ['unpatchedStdlibExecuted', 'actualUnpatchedCorruptionClaimed', 'fullWasiAcceptance', 'compilerR0R1', 'browserKotlinCompilation', 'languageReadiness'])
    assert.equal(actual[key], false);
assert.deepEqual(actual.commands.map(item => [item.phase, item.exitCode]), [['source', 0], ['binary', 0], ['node', 0]]);
const artifacts = new Set();
for (const pin of actual.artifacts) {
    relativePath(pin.path); assert(!artifacts.has(pin.path)); artifacts.add(pin.path);
    verifyContent(await readRegular(path.join(root, pin.path), pin.bytes), pin);
}
for (const pin of actual.localTools) verifyContent(await readRegular(path.join(HERE, pin.path)), pin);
const targetBytes = await readRegular(actual.stdlibBuildReceipt.filename);
assert.equal(sha256(targetBytes), actual.stdlibBuildReceipt.sha256);
const target = JSON.parse(targetBytes), recipe = await loadRecipe();
validateTargetReceipt(target, recipe, sha256(await readRegular(path.join(HERE, '../recipe.json'))));
assert.deepEqual(target.stdlib, actual.stdlib); assert.deepEqual(actual.source, recipe.source);
verifyContent(await readRegular(actual.stdlibFile, actual.stdlib.bytes), actual.stdlib);
const bootstrap = await verifyBootstrap();
assert.deepEqual(actual.compiler.artifacts, bootstrap.artifacts); assert.equal(actual.compiler.version, bootstrap.lock.version);
assert.equal(actual.compiler.sourceCommit, null); assert.equal(actual.compiler.role, 'official-bootstrap');
for (const pin of actual.sourceReferences) verifyFile(await readRegular(pin.filename), pin);
verifyFile(await readRegular(actual.abi.filename), actual.abi.header);
const node = JSON.parse(await readRegular(path.join(root, 'node.json')));
const chromium = JSON.parse(await readRegular(path.join(root, 'chromium.json')));
assert.equal(chromium.observations.length, 2);
for (const record of chromium.observations) assert.deepEqual(record, node);
assert.deepEqual(chromium.browser, actual.browser); assert.equal(actual.browser.engine, 'Chromium');
assert.equal(actual.browser.offlineBeforeWasmCompilationAndExecution, true);
for (const key of ['externalRequests', 'offlineRequests', 'pageErrors']) assert.deepEqual(actual.browser[key], []);
assert.equal(node.allocations.length, 81); assert(node.allocations.every(row => row.kotlinObservedDamagedBytes === 0));
assert.deepEqual(node.allocations.slice(-4).map(row => [row.request, row.abiBytes, row.mode, row.distance, row.overlap]),
    [[20, 48, 1, 24, 24], [48, 48, 1, 48, 0], [26, 32, 2, 32, 0], [32, 32, 2, 32, 0]]);
assert.equal(node.polls.length, 1); assert.equal(node.polls[0].subscriptionBytes, 48);
assert.equal(node.polls[0].eventBytes, 32); assert.equal(node.polls[0].subscriptionUnchanged, true);
assert.equal(node.stdout, 'poll-canary-λ\n'); assert.deepEqual(node.randomRequests, []);
assert.equal(node.writes[0].errno, 6); assert.equal(node.writes.slice(1).reduce((sum, row) => sum + row.written, 0), 15);
for (const pin of [evidence.execution.log, evidence.execution.status, ...evidence.retainedFailure.pins])
    verifyContent(await readRegular(pin.filename, pin.bytes), pin);
assert.equal(JSON.parse(await readRegular(evidence.execution.status.filename)).exitCode, 0);
assert.equal(JSON.parse(await readRegular(evidence.retainedFailure.statusFile)).exitCode, 1);
console.log(JSON.stringify({ allocationsPerRun: 81, actualPollCallsPerRun: 1, executions: 3,
    offlineWorkers: 2, artifacts: artifacts.size, fullWasiAcceptance: false, browserKotlinCompilation: false }));
