import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
async function pin(filename) { const bytes = await readRegular(filename, 64 * 1024 * 1024); return { filename, bytes: bytes.length, sha256: sha256(bytes) }; }
async function verify(filename, expected) { const actual = await pin(filename); assert.equal(actual.bytes, expected.bytes); assert.equal(actual.sha256, expected.sha256); }
const jobs = {}, snapshots = {}, records = [];
for (const [name, jobFile] of [['runtime', process.argv[2]], ['integrity', process.argv[3]], ['early', process.argv[4]]]) {
    const job = JSON.parse(await readRegular(path.resolve(jobFile))), status = JSON.parse(await readRegular(job.status));
    assert.equal(status.exitCode, 0, 'Proof job must have completed successfully');
    const outputRoot = path.resolve(job.argv.at(-1)), receiptPath = path.join(outputRoot, 'receipt.json'), bytes = await readRegular(receiptPath, 64 * 1024 * 1024);
    const receipt = JSON.parse(bytes); assert.equal(receipt.result, 'pass');
    for (const input of receipt.filePins ?? receipt.inputPins ?? []) await verify(input.filename ?? path.join(HERE, input.path), input);
    for (const artifact of receipt.artifacts ?? []) await verify(path.join(outputRoot, artifact.path), artifact);
    snapshots[name] = bytes;
    jobs[name] = { ...job, outputRoot, execution: status, receipt: await pin(receiptPath), logPin: await pin(job.log), statusPin: await pin(job.status), jobFile: await pin(path.resolve(jobFile)) };
    records.push({ name, inputsRehashed: (receipt.filePins ?? receipt.inputPins ?? []).length, artifactsRehashed: (receipt.artifacts ?? []).length });
}
const runtime = JSON.parse(snapshots.runtime), integrity = JSON.parse(snapshots.integrity), early = JSON.parse(snapshots.early);
assert.equal(runtime.genuineFunctionInvokeWholeSourceRebuilt, true); assert.equal(runtime.observations, 32);
assert.equal(integrity.negatives.length, 10); assert.equal(integrity.historical.selectedSources, 3524); assert.equal(integrity.positive.selectedSources, 3527);
assert.equal(integrity.exactPredecessorInventoryRestored, true); assert.equal(early.checkedCanonicalDependencies.length, 11);
const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
for (const p of [...lock.dependencies, ...lock.common]) await verify(path.join(HERE, p.path), p);
assert.equal(integrity.positive.sourceLockSha256, sha256(lockBytes)); assert.equal(early.final.sourceLockSha256, sha256(lockBytes));
const currentFiles = [];
for (const name of (await readdir(HERE)).sort()) if (name !== 'evidence') currentFiles.push(await pin(path.join(HERE, name)));
const evidence = path.join(HERE, 'evidence'); await mkdir(evidence, { mode: 0o700 });
for (const [name, bytes] of Object.entries(snapshots)) await writeFile(path.join(evidence, name + '.json'), bytes, { mode: 0o600, flag: 'wx' });
await writeFile(path.join(evidence, 'executions.json'), JSON.stringify({ schemaVersion: 1, kind: 'genuine-descriptor-function-completed-executions', jobs, records,
    currentFiles, sourceLockSha256: sha256(lockBytes), copiedEvidence: await Promise.all(Object.keys(snapshots).map(name => pin(path.join(evidence, name + '.json')))),
    fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ result: 'sealed', records, liveUnitFiles: currentFiles.length }));
