import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const jobs = [];
for (const [i, manifestPath] of process.argv.slice(2).entries()) {
    const manifestBytes = await readRegular(manifestPath), manifest = JSON.parse(manifestBytes);
    const statusBytes = await readRegular(manifest.status), status = JSON.parse(statusBytes);
    assert.equal(status.state, 'exited'); assert.equal(status.exitCode, 0); assert.equal(status.pid, manifest.pid);
    const receiptPath = path.join(manifest.output, 'receipt.json'), receiptBytes = await readRegular(receiptPath, 64 * 1024 * 1024), receipt = JSON.parse(receiptBytes);
    assert.equal(receipt.result, 'pass');
    assert.equal(receipt.kind, i === 0 ? 'genuine-descriptor-lazy-mutable-integrity' : 'genuine-descriptor-lazy-mutable-full-jvm-proof');
    for (const pin of receipt.filePins) { const bytes = await readRegular(pin.filename, 100 * 1024 * 1024); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); }
    if (receipt.commands) assert(receipt.commands.every(command => command.exitCode === 0));
    const logBytes = await readRegular(manifest.log, 16 * 1024 * 1024), runnerBytes = await readRegular(manifest.runner);
    jobs.push({ manifestPath, manifestSha256: sha256(manifestBytes), ...manifest, status, statusSha256: sha256(statusBytes),
        logSha256: sha256(logBytes), runnerSha256: sha256(runnerBytes), receiptPath, receiptSha256: sha256(receiptBytes), receipt });
}
assert.equal(jobs.length, 2);
assert.equal(jobs[0].receipt.positive.selectedSources, 3553); assert.equal(jobs[0].receipt.exactContractPredecessorsRestored, 1);
assert.equal(jobs[0].receipt.immutableHistoricalFilesModified, false);
const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
assert.equal(jobs[0].receipt.positive.sourceLockSha256, sha256(lockBytes));
const shippingPins = [];
for (const name of ['sources.lock.json', ...lock.common.map(pin => pin.path), 'contracts/CanonicalSuspendFunctionTypes.kt', 'contracts/SuspendFunctionTypes.kt',
    'prepare.mjs', 'transform.mjs', 'fixture.mjs', 'integrity.mjs', 'probe.mjs', 'proof/LazyMutableBehaviorProbe.java', 'update-lock.mjs', 'evidence.mjs']) {
    const bytes = await readRegular(path.join(HERE, name)); shippingPins.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
}
await mkdir(path.join(HERE, 'evidence'), { recursive: true });
for (const [i, name] of ['integrity.json', 'runtime.json'].entries()) await writeFile(path.join(HERE, 'evidence', name), JSON.stringify(jobs[i].receipt, null, 2) + '\n');
await writeFile(path.join(HERE, 'evidence/executions.json'), JSON.stringify({ schemaVersion: 1, kind: 'genuine-descriptor-lazy-mutable-completed-executions',
    source: lock.source, sourceLockSha256: sha256(lockBytes), shippingPins, jobs: jobs.map(({ receipt, ...job }) => job),
    result: 'pass', fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false }, null, 2) + '\n');
console.log(JSON.stringify({ result: 'pass', integrityGuards: jobs[0].receipt.negatives.length, jvmObservations: jobs[1].receipt.observations }));
