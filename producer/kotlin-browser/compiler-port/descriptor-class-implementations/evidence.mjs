import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
assert.equal(process.argv.length, 5, 'Usage: evidence.mjs RUNTIME_JOB INTEGRITY_JOB EARLY_JOB');
const expected = {
 runtime: { script: 'probe.mjs', kind: 'genuine-descriptor-class-full-jvm-proof' },
 integrity: { script: 'integrity.mjs', kind: 'genuine-descriptor-class-integrity' },
 early: { script: 'early.mjs', kind: 'genuine-descriptor-class-early-boundaries' },
};
async function pin(filename) { const bytes = await readRegular(filename, 64 * 1024 * 1024); return { filename, bytes: bytes.length, sha256: sha256(bytes) }; }
async function verify(filename, expected) { const actual = await pin(filename); assert.equal(actual.bytes, expected.bytes); assert.equal(actual.sha256, expected.sha256); }
const jobs = {}, snapshots = {}, records = [];
for (const [name, jobFile] of [['runtime', process.argv[2]], ['integrity', process.argv[3]], ['early', process.argv[4]]]) {
    const job = JSON.parse(await readRegular(path.resolve(jobFile))), status = JSON.parse(await readRegular(job.status));
    assert.equal(status.state, 'exited'); assert.equal(status.exitCode, 0, 'Proof job must have completed successfully');
    assert.equal(status.pid, job.pid, 'Proof status belongs to a different job');
    assert(Number.isInteger(job.pid) && job.pid > 0 && Number.isFinite(status.durationSeconds) && status.durationSeconds > 0);
    assert.equal(job.argv.length, 3); assert.equal(path.resolve(REPO, job.argv[1]), path.join(HERE, expected[name].script));
    assert.equal(path.resolve(job.argv[2]), path.resolve(job.output), 'Proof harness output binding changed');
    const outputRoot = path.resolve(job.output), receiptPath = path.join(outputRoot, 'receipt.json'), bytes = await readRegular(receiptPath, 64 * 1024 * 1024);
    const receipt = JSON.parse(bytes); assert.equal(receipt.result, 'pass'); assert.equal(receipt.kind, expected[name].kind);
    assert.equal(receipt.fullCompilerBuilt, false); assert.equal(receipt.languageReadiness, false);
    for (const input of receipt.filePins) await verify(input.filename, input);
    for (const artifact of receipt.artifacts ?? []) await verify(path.join(outputRoot, artifact.path), artifact);
    snapshots[name] = bytes;
    jobs[name] = { ...job, execution: status, receipt: await pin(receiptPath), logPin: await pin(job.log), statusPin: await pin(job.status),
        runnerPin: await pin(job.runner), jobFile: await pin(path.resolve(jobFile)) };
    records.push({ name, inputsRehashed: receipt.filePins.length, artifactsRehashed: (receipt.artifacts ?? []).length });
}
const runtime = JSON.parse(snapshots.runtime), integrity = JSON.parse(snapshots.integrity), early = JSON.parse(snapshots.early);
assert.equal(runtime.observations, 33); assert.equal(runtime.commands.length, 7); assert(runtime.commands.every(command => command.exitCode === 0));
assert.equal(runtime.rawConstructorReturnBeforeInitializationParity, false);
assert.equal(runtime.commonOverridingUtilClosureOpen, true); assert.equal(runtime.commonDescriptorUtilsClosureOpen, true);
const rawRecords = [];
for (const variant of ['original','common']) {
 const bytes = await readRegular(path.join(jobs.runtime.output, variant + '-observe.stdout'));
 const lines = bytes.toString().trimEnd().split('\n');
 assert.deepEqual(lines.filter(row => row.startsWith('boundary:')), runtime.boundaries[variant]);
 const records = lines.filter(row => row.startsWith('record:'));
 assert.equal(records.length, runtime.observations); assert.equal(sha256(Buffer.from(records.join('\n'))), runtime.comparedRecordsSha256); rawRecords.push(records);
}
assert.deepEqual(rawRecords[0], rawRecords[1]);
assert.deepEqual(runtime.boundaries.original, [
 'boundary:empty-lazy-declared-parameters:null',
 'boundary:parameter-output-java-mutation:java.lang.UnsupportedOperationException',
 'boundary:supertype-output-java-mutation:java.lang.UnsupportedOperationException',
 'boundary:cold-class-constructors:null',
 'boundary:cold-class-scope:null',
]);
assert.deepEqual(runtime.boundaries.common, [
 'boundary:empty-lazy-declared-parameters:java.lang.NullPointerException',
 'boundary:parameter-output-java-mutation:java.lang.UnsupportedOperationException',
 'boundary:supertype-output-java-mutation:true',
 'boundary:cold-class-constructors:java.lang.NullPointerException',
 'boundary:cold-class-scope:java.lang.NullPointerException',
]);
assert.equal(integrity.negatives.length, 16); assert.equal(integrity.historical.selectedSources, 3540); assert.equal(integrity.positive.selectedSources, 3549);
assert.equal(integrity.exactPredecessorInventoryRestored, true); assert.equal(integrity.exactContractPredecessorsRestored, 3);
assert.equal(early.checkedCanonicalDependencies, 28); assert.equal(early.checkedCanonicalConsumers, 7);
const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
for (const source of [...lock.dependencies, ...lock.common]) await verify(path.join(HERE, source.path), source);
for (const contract of lock.contracts) { await verify(path.join(HERE, contract.input.localPath), contract.input); await verify(path.join(HERE, contract.output.localPath), contract.output); }
assert.equal(integrity.positive.sourceLockSha256, sha256(lockBytes)); assert.equal(early.final.sourceLockSha256, sha256(lockBytes));
const currentFiles = [];
async function inventory(directory) {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (directory === HERE && item.name === 'evidence') continue;
        const filename = path.join(directory, item.name); if (item.isDirectory()) await inventory(filename); else currentFiles.push(await pin(filename));
    }
}
await inventory(HERE);
const evidence = path.join(HERE, 'evidence'); await mkdir(evidence, { mode: 0o700 });
for (const [name, bytes] of Object.entries(snapshots)) await writeFile(path.join(evidence, name + '.json'), bytes, { mode: 0o600, flag: 'wx' });
await writeFile(path.join(evidence, 'executions.json'), JSON.stringify({ schemaVersion: 1, kind: 'genuine-descriptor-class-completed-executions', jobs, records,
    currentFiles, sourceLockSha256: sha256(lockBytes), copiedEvidence: await Promise.all(Object.keys(snapshots).map(name => pin(path.join(evidence, name + '.json')))),
    rawConstructorReturnBeforeInitializationParity: false, fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ result: 'sealed', records, liveUnitFiles: currentFiles.length }));
