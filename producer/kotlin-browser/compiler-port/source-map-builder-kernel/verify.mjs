import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertNoSymlink, readRegular, relativePath, sha256 } from '../../scripts/source.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { verifySourceMapBuilder } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export async function verifySourceMapBuilderEvidence(evidence) {
    assert.equal(evidence.schemaVersion, 1); assert.equal(evidence.kind, 'genuine-source-map-builder-full-ast-four-host-profile');
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(evidence.sourceLockSha256, sha256(lockBytes)); assert.deepEqual(evidence.source, lock.source);
    assert.equal(evidence.checkToolSha256, lock.tools.find(pin => pin.path === 'check.mjs').sha256);
    assert.equal(evidence.execution.state, 'exited'); assert.equal(evidence.execution.exitCode, 0);
    const root = path.resolve(evidence.execution.outputRoot); assert(root.startsWith(path.join(REPO, 'out') + path.sep)); await assertNoSymlink(root);
    async function checked(filename, pin) { const bytes = await readRegular(filename, pin.bytes); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); return bytes; }
    const seen = new Set();
    for (const pin of evidence.outputs) { relativePath(pin.path); assert(!seen.has(pin.path)); seen.add(pin.path); await checked(path.join(root, pin.path), pin); }
    for (const pin of evidence.unitFiles) await checked(path.join(HERE, relativePath(pin.path)), pin);
    for (const pin of [evidence.execution.logPin, evidence.execution.statusPin]) await checked(pin.path, pin);
    const status = JSON.parse(await readRegular(evidence.execution.status)); assert.equal(status.exitCode, 0); assert.equal(status.state, 'exited');
    const actualReceipt = JSON.parse(await checked(path.join(root, 'receipt.json'), evidence.execution.receiptPin));
    assert.deepEqual(Object.fromEntries(Object.keys(actualReceipt).map(key => [key,evidence[key]])), actualReceipt);
    assert.equal(evidence.commands.length, 11); assert(evidence.commands.every(command => command.exitCode === 0));
    const observations = [];
    for (const name of ['original-jvm.json','portable-jvm.json','portable-wasm.json','portable-chromium.json']) observations.push(JSON.parse(await readRegular(path.join(root, name))));
    for (const actual of observations) { assert.deepEqual(actual.records, observations[0].records); assert.equal(actual.records.length, evidence.comparison.observations); }
    assert(observations[0].records.length >= 1000); assert.equal(sha256(Buffer.from(JSON.stringify(observations[0].records))), evidence.comparison.recordsSha256);
    assert.equal(evidence.comparison.normalization, false); assert.equal(evidence.comparison.skipped, 0);
    assert.deepEqual(evidence.rawNativeReaderDiagnostics, Object.fromEntries(['originalJvm','commonJvm','nodeWasm','offlineChromium'].map((host,index) => [host,observations[index].rawFailures])));
    for (const field of ['originalJvmEqualsCommonJvm','originalJvmEqualsNodeWasm','originalJvmEqualsOfflineChromium']) assert.equal(evidence.comparison[field], true);
    assert.deepEqual(evidence.identityContract, lock.identityContract);
    for (const field of ['nativeStacktraceTextParity','originalGlobalStderrParity','callerIntegrated','pathResolverBuilt','fullCompilerBuilt','languageReadiness']) assert.equal(evidence[field], false);
    assert.equal(evidence.fastutil.compilerAstClassesExtracted, false);
    assert(evidence.fastutil.classes.length > 0 && evidence.fastutil.classes.every(pin => pin.path.startsWith('org/jetbrains/kotlin/it/unimi/dsi/fastutil/')));
    const bootstrap = await verifyBootstrap(), compiler = bootstrap.artifacts.find(pin => pin.id === 'compiler');
    const fastutil = JSON.parse(await readRegular(path.join(root, 'fastutil.json')));
    assert.deepEqual(fastutil, { ...evidence.fastutil, archive: compiler });
    assert.deepEqual(evidence.oracleFastutilArchive, { id: compiler.id, bytes: compiler.bytes, sha256: compiler.sha256, importRelocationOnly: true });
    const verification = JSON.parse((await promisify(execFile)('python3', [path.join(HERE,'extract-fastutil.py'),'--verify',compiler.path,path.join(root,'fastutil.jar'),path.join(root,'fastutil.json')],{timeout:30000,maxBuffer:4096})).stdout);
    assert.deepEqual(verification,{classes:evidence.fastutil.classes.length,verifiedAgainstPinnedArchive:true});
    assert.equal(evidence.browser.engine,'Chromium'); assert.equal(evidence.browser.moduleWorker,true); assert.equal(evidence.browser.offlineAfterInitialization,true);
    for (const field of ['externalRequests','offlineRequests','pageErrors']) assert.deepEqual(evidence.browser[field],[]);
    const prepared = await verifySourceMapBuilder({ sourceRoot: path.join(REPO, 'out/kotlin-compiler-port/sources'), outputRoot: path.join(root,'kernel'), receiptPath: path.join(root,'kernel/source-map-builder-kernel-inputs.json') });
    assert.deepEqual(prepared, evidence.preparation);
    const guard = evidence.integrity, integrity = JSON.parse(await checked(guard.receiptPath, guard.receiptPin));
    assert.deepEqual([integrity.passed,integrity.failed,integrity.skipped], [18,0,0]); assert.equal(integrity.sourceLockSha256, sha256(lockBytes));
    for (const pin of [guard.logPin, guard.statusPin]) await checked(pin.path, pin);
    assert.equal(JSON.parse(await readRegular(guard.status)).exitCode, 0);
    if (evidence.retainedEarlierProfile) {
        const earlier = evidence.retainedEarlierProfile;
        for (const pin of earlier.snapshotPins) await checked(pin.path,pin);
        for (const pin of earlier.outputs) await checked(path.join(earlier.outputRoot,relativePath(pin.path)),pin);
        for (const pin of [earlier.logPin,earlier.statusPin,earlier.receiptPin]) await checked(pin.path,pin);
        const original = JSON.parse(await readRegular(path.join(earlier.outputRoot,'original-jvm.json')));
        assert.equal(original.records.length,1312);
        for (const name of ['portable-jvm.json','portable-wasm.json','portable-chromium.json']) assert.deepEqual(JSON.parse(await readRegular(path.join(earlier.outputRoot,name))).records,original.records);
        assert.equal(JSON.parse(await readRegular(earlier.statusPin.path)).exitCode,0);
    }
    return { outputs: evidence.outputs.length, unitFiles: evidence.unitFiles.length, observations: evidence.comparison.observations, guards: integrity.passed, fullCompilerBuilt: false };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await verifySourceMapBuilderEvidence(JSON.parse(await readRegular(path.join(HERE,'evidence/receipt.json'))))));
