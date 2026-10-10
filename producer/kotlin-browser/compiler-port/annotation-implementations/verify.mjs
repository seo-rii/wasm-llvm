import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { verifyAnnotationImplementations } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export async function verifyAnnotationImplementationEvidence() {
    const evidence = JSON.parse(await readRegular(path.join(HERE, 'evidence/receipt.json')));
    assert.equal(evidence.kind, 'genuine-annotation-implementation-evidence');
    async function check(pin) {
        const bytes = await readRegular(pin.filename, pin.bytes);
        assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); return bytes;
    }
    for (const pin of evidence.unitFiles) await check(pin);
    const runtime = JSON.parse(await check(evidence.runtimeReceipt));
    assert.equal(runtime.kind, 'genuine-annotation-carriers-full-jvm-proof'); assert.equal(runtime.result, 'pass');
    assert.equal(runtime.sourceLockSha256, sha256(await readRegular(path.join(HERE, 'sources.lock.json'))));
    const root = path.resolve(runtime.outputRoot); assert(root.startsWith(path.join(REPO, 'out') + path.sep));
    assert.deepEqual(await verifyAnnotationImplementations(path.join(root, 'prepared')), runtime.preparation);
    for (const pin of runtime.artifacts) {
        const filename = path.resolve(root, pin.path); assert(filename.startsWith(root + path.sep));
        await check({ ...pin, filename });
    }
    const bootstrap = await verifyBootstrap(); assert.equal(runtime.bootstrap.version, bootstrap.lock.version);
    assert.deepEqual(runtime.bootstrap.artifacts, bootstrap.artifacts); assert.equal(runtime.bootstrap.sourceCommit, null);
    assert.equal(runtime.commands.length, 6); assert(runtime.commands.every(command => command.exitCode === 0));
    const raw = await Promise.all(['original', 'common'].map(async name => (await readRegular(path.join(root, name + '-observe.stdout'))).toString()));
    const records = raw.map(text => text.split('\n').filter(line => line.startsWith('record:')));
    assert.deepEqual(records[0], records[1]); assert.equal(records[0].length, 1052); assert.equal(runtime.observations, 1052);
    assert.equal(sha256(Buffer.from(records[0].join('\n'))), runtime.recordsSha256); assert.equal(runtime.normalization, false);
    const invalid = raw.map(text => text.split('\n').filter(line => line.startsWith('invalid:')));
    assert.deepEqual(invalid[0], runtime.originalInvalidJavaNullConstruction);
    assert.deepEqual(invalid[1], runtime.commonInvalidJavaNullConstruction);
    assert.equal(invalid[0].length, 4); assert.equal(invalid[1].length, 4); assert.notDeepEqual(invalid[0], invalid[1]);
    for (const field of ['fullCommonClassesWasmExecuted', 'fullCompilerBuilt', 'languageReadiness']) assert.equal(runtime[field], false);
    for (const job of Object.values(evidence.executions)) {
        await check(job.log); assert.equal(JSON.parse(await check(job.status)).exitCode, 0);
    }
    const guard = (await readRegular(evidence.executions.guards.log.filename)).toString();
    assert(guard.includes('pass 4') && guard.includes('fail 0') && guard.includes('skipped 0'));
    for (const pin of evidence.initialMissingFactoryReference.pins) await check(pin);
    return { observations: 1052, guards: 4, commands: 6, artifacts: runtime.artifacts.length,
        rawInvalidNullDifferences: 4, fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await verifyAnnotationImplementationEvidence()));
