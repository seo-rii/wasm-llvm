import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
assert.equal(process.argv.length, 3, 'Usage: seal-evidence.mjs COMPLETED_JOB_MANIFEST');
const manifestPath = path.resolve(process.argv[2]), job = JSON.parse(await readRegular(manifestPath));
const status = JSON.parse(await readRegular(job.status));
assert.equal(status.state, 'exited'); assert.equal(status.exitCode, 0); assert.equal(status.pid, job.pid);
assert.deepEqual(status.argv, job.argv); assert.equal(job.argv.length, 3);
assert.equal(job.argv[1], path.join(HERE, 'probe.mjs')); assert.equal(job.argv[2], job.root);
assert(job.root.startsWith(path.join(REPO, 'out/distribution-path-proof-')));
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
async function pin(filename) { return { filename, ...identity(await readRegular(filename, 64 * 1024 * 1024)) }; }
for (const row of [job.scriptPin, job.scriptSnapshotPin, job.runnerPin]) assert.deepEqual(await pin(row.filename), row, 'Executed source or supervisor changed');
assert.equal(job.scriptPin.filename, job.argv[1]); assert.equal(job.runnerPin.filename, job.runner);
assert.equal(job.scriptPin.sha256, job.scriptSnapshotPin.sha256);
const rawPath = path.join(job.root, 'receipt.json'), rawBytes = await readRegular(rawPath, 64 * 1024 * 1024), proof = JSON.parse(rawBytes);
assert.equal(proof.kind, 'actual-distribution-path-selection-and-tail-proof'); assert.equal(proof.result, 'pass');
assert.equal(proof.actualSourcesBefore, 3550); assert.equal(proof.actualSourcesAfter, 3547);
assert.equal(proof.reasonMatchedNegativeChecks, 18); assert.equal(proof.negatives.length, 18);
for (const row of proof.negatives) { assert.equal(row.code, 'ERR_ASSERTION'); assert.equal(row.result, 'rejected'); assert(row.reason.startsWith(row.expectedReason)); assert(!/ENOENT|EEXIST/.test(row.reason)); }
assert.equal(proof.restoredPositivePassed, true); assert.equal(proof.exactPredecessorRowsAndOrderRestored, true);
assert.equal(proof.historicalDirectoriesAndFilesUnchanged, true); assert.equal(proof.commonOutputs, 0);
assert.equal(proof.explicitPublicTailCalls, 4); assert.equal(proof.nestedPublicTailCallsIncludingRepeatedComposition, 10);
assert.deepEqual(proof.publicTailCalls.map(row => row.method), ['verifyServiceLoaderFinalSources', 'verifyKlibDiskFinalSources', 'verifyJvmUtilityFinalSources', 'verifyNioUtilityFinalSources']);
for (const row of proof.publicTailCalls) assert.equal(row.result, 'pass');
for (const key of ['fullCompilerBuilt', 'filesystemImplemented', 'languageReadiness']) assert.equal(proof[key], false);
for (const row of [...proof.currentInputs, ...proof.historicalExecutionPins, ...proof.originalSourcePins]) assert.deepEqual(await pin(row.filename), row, 'Proof input changed after execution');
assert.deepEqual(await pin(proof.preparationReceipt.filename), proof.preparationReceipt);
const finalRows = JSON.parse(await readRegular(path.join(job.root, 'final-sources.json')));
assert.equal(finalRows.length, 3547); assert(finalRows.every(row => row.compile === true));
assert.equal(sha256(Buffer.from(JSON.stringify(finalRows))), proof.finalSourceInventorySha256);
const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
assert.equal(proof.final.sourceLockSha256, sha256(lockBytes)); assert.deepEqual(proof.sourceSetExclusions, lock.targets.map(row => row.path));
const currentUnitInputs = [];
for (const filename of ['prepare.mjs', 'references.mjs', 'update-lock.mjs', 'probe.mjs', 'sources.lock.json', 'README.md', 'seal-evidence.mjs']) currentUnitInputs.push(await pin(path.join(HERE, filename)));
const executionPins = await Promise.all([manifestPath, job.status, job.log, job.runner, job.scriptSnapshotPin.filename].map(pin));
const preparedRoot = path.dirname(proof.preparationReceipt.filename);
const artifacts = await Promise.all([rawPath, path.join(job.root, 'inputs-before.json'), path.join(job.root, 'final-sources.json'), proof.preparationReceipt.filename,
    ...lock.targets.flatMap(row => ['original', 'predecessor'].map(directory => path.join(preparedRoot, directory, row.path)))].map(pin));
const primary = JSON.parse(await readRegular(path.join(HERE, '../closure.lock.json'))), primaryOriginalPins = [];
for (const original of primary.files.filter(row => ['kotlin', 'java'].includes(row.language))) {
    const filename = path.join(proof.sourceRoot, original.path), actual = await pin(filename);
    assert.equal(actual.bytes, original.bytes); assert.equal(actual.sha256, original.sha256); primaryOriginalPins.push(actual);
}
let preservedFailedAttempt = null;
if (job.preservedFailedAttempt) {
    const priorJob = JSON.parse(await readRegular(job.preservedFailedAttempt)), priorStatus = JSON.parse(await readRegular(priorJob.status));
    assert.equal(priorStatus.state, 'exited'); assert.equal(priorStatus.exitCode, 1); assert.equal(priorStatus.pid, priorJob.pid);
    assert.deepEqual(priorStatus.argv, priorJob.argv);
    for (const row of [priorJob.scriptSnapshotPin, priorJob.runnerPin]) assert.deepEqual(await pin(row.filename), row);
    preservedFailedAttempt = { job: priorJob, status: priorStatus,
        pins: await Promise.all([job.preservedFailedAttempt, priorJob.status, priorJob.log, priorJob.runner, priorJob.scriptSnapshotPin.filename].map(pin)),
        failureStage: 'Initial new-unit dependency pin validation: generator omitted the Git blob field required by verifyFile.',
        successfulCompilerClaimed: false };
}
const summary = { schemaVersion: 1, kind: 'distribution-path-source-selection-evidence', result: 'pass', source: lock.source,
    sourceLockSha256: sha256(lockBytes), rawProof: { filename: rawPath, ...identity(rawBytes) }, elapsedSeconds: proof.elapsedSeconds,
    actualCompilerArgumentVectorSources: 3550, actualSelectedSources: 3547, completeOriginalFiles: 3, commonOutputs: 0,
    sourceSetExclusions: proof.sourceSetExclusions, final: proof.final, reasonMatchedNegativeChecks: proof.negatives,
    explicitPublicTailCalls: 4, nestedPublicTailCallsIncludingRepeatedComposition: 10,
    fullRowsOwnersAndOrderRestored: true, historicalDirectoriesAndFilesUnchanged: true,
    historicalCompilerExitCode: 1, filesystemImplemented: false, fullCompilerBuilt: false, languageReadiness: false };
const summaryPath = path.join(HERE, 'evidence/selection.json'); await writeJson(summaryPath, summary);
await writeJson(path.join(HERE, 'evidence/execution.json'), { schemaVersion: 1, kind: 'distribution-path-source-profile-completed-execution', result: 'pass',
    source: lock.source, sourceLockSha256: sha256(lockBytes), summaryPin: await pin(summaryPath), job, status, executionPins,
    currentUnitInputs, currentDependencyInputs: proof.currentInputs, artifacts, primaryOriginalPins, preservedFailedAttempt,
    actualSourceOwnerPins: proof.originalSourcePins, immutableHistoricalExecutionPins: proof.historicalExecutionPins,
    immutableHistoricalEntryCount: proof.historicalInventory.length, verifiedSupervisorPid: job.pid,
    exactArgvAndScriptSnapshotVerified: true, fullCompilerBuilt: false, filesystemImplemented: false, languageReadiness: false });
console.log(JSON.stringify({ result: 'pass', before: 3550, after: 3547, negatives: 18, tailCalls: 4, evidence: path.join(HERE, 'evidence/execution.json') }));
