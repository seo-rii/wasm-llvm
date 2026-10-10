import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export async function verifySourceMapRuntimeEvidence(evidence) {
    assert.equal(evidence.schemaVersion, 1); assert.equal(evidence.kind, 'genuine-source-map-runtime-full-ast-four-host-profile');
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(evidence.sourceLockSha256, sha256(lockBytes)); assert.deepEqual(evidence.source, lock.source);
    assert.equal(evidence.checkToolSha256, lock.tools.find(pin => pin.path === 'check.mjs').sha256);
    assert.equal(evidence.execution.state, 'exited'); assert.equal(evidence.execution.exitCode, 0);
    const root = path.resolve(evidence.execution.outputRoot); assert(root.startsWith(path.join(path.resolve(HERE, '../../../..'), 'out') + path.sep));
    async function checked(filename, pin) { const bytes = await readRegular(filename, pin.bytes); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); return bytes; }
    const seen = new Set();
    for (const pin of evidence.outputs) {
        assert(!seen.has(pin.path)); seen.add(pin.path);
        assert(/^[A-Za-z0-9_./-]+$/.test(pin.path) && !pin.path.split('/').some(part => part === '..' || part === '.'));
        await checked(path.join(root, pin.path), pin);
    }
    for (const pin of evidence.unitFiles) await checked(path.join(HERE, pin.path), pin);
    for (const pin of [evidence.execution.logPin, evidence.execution.statusPin]) await checked(pin.path, pin);
    const status = JSON.parse(await readRegular(evidence.execution.status)); assert.equal(status.exitCode, 0); assert.equal(status.state, 'exited');
    assert.equal(evidence.commands.length, 9); assert(evidence.commands.every(command => command.exitCode === 0));
    const observations = [];
    for (const name of ['original-jvm.json', 'portable-jvm.json', 'portable-wasm.json', 'portable-chromium.json']) observations.push(JSON.parse(await readRegular(path.join(root, name))));
    for (const actual of observations) { assert.deepEqual(actual.records, observations[0].records); assert.equal(actual.records.length, evidence.comparison.observations); }
    assert.equal(sha256(Buffer.from(JSON.stringify(observations[0].records))), evidence.comparison.recordsSha256);
    for (const name of ['originalJvmEqualsCommonJvm','originalJvmEqualsNodeWasm','originalJvmEqualsOfflineChromium']) assert.equal(evidence.comparison[name], true);
    assert.equal(evidence.comparison.normalization, false); assert.equal(evidence.comparison.skipped, 0);
    const nulls = observations[0].records.filter(record => record.startsWith('null-function-body-'));
    assert.equal(nulls.length, 2); assert(nulls.every(record => /^null-function-body-(?:false|true):true:/.test(record)));
    for (const name of ['entryRuntimeInstalled','originalGlobalStdoutParity','fullJsAstUtilsBuilt','sourceMapBuilderBuilt','fullCompilerBuilt','languageReadiness']) assert.equal(evidence[name], false);
    const guard = evidence.integrity, integrity = JSON.parse(await checked(guard.receiptPath, guard.receiptPin));
    assert.equal(integrity.passed, 25); assert.equal(integrity.failed, 0); assert.equal(integrity.skipped, 0);
    for (const pin of [guard.logPin, guard.statusPin]) await checked(pin.path, pin);
    assert.equal(JSON.parse(await readRegular(guard.status)).exitCode, 0);
    return { outputs: evidence.outputs.length, unitFiles: evidence.unitFiles.length, observations: evidence.comparison.observations, guards: integrity.passed, fullCompilerBuilt: false };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await verifySourceMapRuntimeEvidence(JSON.parse(await readRegular(path.join(HERE, 'evidence/receipt.json'))))));
