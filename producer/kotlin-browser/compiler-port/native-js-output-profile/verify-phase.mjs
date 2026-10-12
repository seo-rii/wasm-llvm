import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, verifyFile } from '../../scripts/source.mjs';
import { readNativeJsOutputLock } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), MAX = 64 * 1024 * 1024;
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
async function content(pin, archiveMap) {
    const original = pin.filename ?? pin.path, archived = archiveMap?.get(original);
    if (archived) assert.deepEqual({ bytes: pin.bytes, sha256: pin.sha256 }, { bytes: archived.bytes, sha256: archived.sha256 });
    const bytes = await readRegular(archived?.archivedFilename ?? original, MAX);
    assert.deepEqual(identity(bytes), { bytes: pin.bytes, sha256: pin.sha256 }); return bytes;
}
async function files(directory) {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name); assert(!entry.isSymbolicLink());
        if (entry.isDirectory()) result.push(...await files(filename));
        else { assert(entry.isFile()); result.push(filename); }
    }
    return result.sort();
}
async function pins(rows, archiveMap) {
    for (let index = 0; index < rows.length; index += 24) {
        const results = await Promise.allSettled(rows.slice(index, index + 24).map(row => content(row, archiveMap)));
        for (const result of results) if (result.status !== 'fulfilled') throw result.reason;
    }
}
async function historical(snapshotManifest) {
    const archive = JSON.parse(await readRegular(snapshotManifest)), snapshot = path.join(path.dirname(snapshotManifest), 'native-js-output-profile');
    assert.equal(archive.kind, 'immutable-native-profile-before-phase-composition');
    assert.equal(archive.files.length, 11); await pins(archive.files);
    const lockBytes = await readRegular(path.join(snapshot, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const evidenceBytes = await readRegular(path.join(HERE, 'evidence/receipt.json'), MAX);
    assert.deepEqual(evidenceBytes, await readRegular(path.join(snapshot, 'evidence/receipt.json'), MAX));
    const evidence = JSON.parse(evidenceBytes); assert.equal(evidence.sourceLockSha256, sha256(lockBytes));
    assert.deepEqual(evidence.source, lock.source);
    assert.equal(evidence.originalSources, 3417); assert.equal(evidence.actualEarlyInputs, 3525); assert.equal(evidence.actualFinalInputs, 3525);
    for (const [name, expected] of Object.entries({ additionalExclusions: 1, unchangedPriorExclusions: 21,
        unchangedLogicalSplits: 4, requiredBoundaryCount: 21, requiredOriginalBoundaryCount: 19, additionalGenuineTypeCount: 2 })) assert.equal(evidence[name], expected);
    for (const name of ['filesystemImplemented', 'fullCompilerBuilt', 'languageReadiness', 'newJvmOrWasmRuntimeExecuted']) assert.equal(evidence[name], false);
    assert.deepEqual(evidence.unitFiles.map(row => row.path).sort(), ['README.md', 'references.mjs', 'prepare.mjs', 'final.mjs', 'update-recipe.mjs', 'probe.mjs', 'guards.mjs', 'verify.mjs', 'sources.lock.json'].sort());
    for (const row of evidence.unitFiles) verifyFile(await readRegular(path.join(snapshot, row.path), MAX), row);
    for (const row of lock.tools) verifyFile(await readRegular(path.join(snapshot, row.path), MAX), row);
    async function execution(run, exitCode) {
        assert.equal(run.exitCode, exitCode); const status = JSON.parse(await content(run.statusPin)); assert.equal(status.exitCode, exitCode);
        assert.equal(run.statusPin.path, run.status); assert.equal(run.logPin.path, run.log); await content(run.logPin);
        assert.deepEqual(run.artifacts.map(row => row.path).sort(), await files(run.outputRoot)); await pins(run.artifacts);
    }
    assert.deepEqual(evidence.executions.map(row => row.phase), ['final-check', 'final-guards']);
    for (const run of evidence.executions) await execution(run, 0);
    const rawCheck = JSON.parse(await readRegular(path.join(evidence.executions[0].outputRoot, 'receipt.json'), MAX));
    for (const [key, value] of Object.entries(rawCheck)) assert.deepEqual(evidence[key], value);
    const integrityBytes = await readRegular(path.join(HERE, 'evidence/integrity.json'), MAX);
    assert.deepEqual(integrityBytes, await readRegular(path.join(snapshot, 'evidence/integrity.json'), MAX));
    assert.deepEqual(identity(integrityBytes), { bytes: evidence.integrityPin.bytes, sha256: evidence.integrityPin.sha256 });
    const integrity = JSON.parse(integrityBytes);
    assert.deepEqual(integrity, JSON.parse(await readRegular(path.join(evidence.executions[1].outputRoot, 'guards.json'), MAX)));
    assert.equal(integrity.guards, 37); assert.equal(integrity.records.length, 37); assert.equal(integrity.skipped, 0);
    assert.equal(integrity.allRejected, true); assert.equal(integrity.restoredFinalPassed, true);
    assert.equal(integrity.eachRejectionMatchedExpectedReason, true); assert.equal(integrity.uniqueFinalOutputRoots, true);
    assert.equal(new Set(integrity.records.map(row => row.name)).size, 37);
    assert(integrity.records.every(row => row.rejected && row.error?.name && row.error?.message));
    for (const name of ['false-compiler-built', 'receipt-source-identity', 'forged-prior-policy', 'module-proof-not-canonical']) assert(integrity.records.find(row => row.name === name)?.assertionTarget?.field);
    await pins(evidence.referencePins);
    assert.equal(evidence.retainedInitialProof.negativeRunInvalidated, true);
    await execution(evidence.retainedInitialProof.executions[0], 0); await execution(evidence.retainedInitialProof.executions[1], 1);
    await pins(evidence.retainedInitialProof.codeSnapshot);
    await execution(evidence.retainedIntermediateCheck.execution, -15); await pins(evidence.retainedIntermediateCheck.codeSnapshot);
    return { sourceLockSha256: sha256(lockBytes), snapshotFiles: archive.files.length, guards: 37,
        originalSourceSnapshotVerified: true, executionIsHistorical: true, currentNoPhaseExecutionClaimed: false };
}

export async function verifyNativePhaseCompositionEvidence({ archiveManifest } = {}) {
    const currentLock = await readNativeJsOutputLock();
    const evidence = JSON.parse(await readRegular(path.join(HERE, 'evidence/phase-composition-execution.json'), MAX));
    assert.equal(evidence.result, 'pass'); assert.deepEqual(evidence.source, currentLock.lock.source);
    let archiveMap;
    if (evidence.sourceLockSha256 !== sha256(currentLock.bytes)) {
        if (!archiveManifest) {
            const currentProfile = JSON.parse(await readRegular(path.join(HERE, '../native-first-phase-source-profile/evidence/selection.json'), MAX));
            const pin = currentProfile.archivedNativePhase.manifest;
            const bytes = await content(pin); archiveManifest = pin.filename;
            assert.equal(JSON.parse(bytes).sourceLockSha256, evidence.sourceLockSha256);
        }
        const archive = JSON.parse(await readRegular(archiveManifest, MAX));
        assert.equal(archive.kind, 'immutable-native-phase-shipping-before-first-phase-exclusion');
        assert.equal(archive.sourceLockSha256, evidence.sourceLockSha256);
        assert.deepEqual(archive.files.map(row => row.filename).sort(), evidence.currentInputs.map(row => row.filename).sort());
        archiveMap = new Map(archive.files.map(row => [row.filename, row]));
        for (const row of archive.files) await content(row, archiveMap);
        assert.equal(sha256(await readRegular(archiveMap.get(path.join(HERE, 'sources.lock.json')).archivedFilename)), evidence.sourceLockSha256);
    } else assert.equal(evidence.sourceLockSha256, sha256(currentLock.bytes));
    const status = JSON.parse(await readRegular(evidence.job.status)); assert.deepEqual(status, evidence.status);
    assert.equal(status.pid, evidence.job.pid); assert.equal(status.state, 'exited'); assert.equal(status.exitCode, 0);
    await pins([...evidence.executionPins, ...evidence.currentInputs, ...evidence.artifacts], archiveMap);
    assert.deepEqual(evidence.artifacts.map(row => row.filename).sort(), await files(evidence.job.output));
    for (const row of evidence.primaryOriginalPins) verifyFile(await readRegular(row.filename, MAX), row);
    assert.equal(evidence.primaryOriginalPins.length, 3417); await pins(evidence.actualHistoricalRows);
    assert.equal(evidence.actualHistoricalRows.length, 3550);
    const rawBytes = await content(evidence.integrityPin), raw = JSON.parse(rawBytes);
    assert.deepEqual(rawBytes, await readRegular(path.join(HERE, 'evidence/phase-composition.json'), MAX));
    await pins(raw.inputs, archiveMap); assert.deepEqual(raw.historicalSources, evidence.actualHistoricalRows);
    assert.deepEqual(raw.passed, evidence.positivePublicChecks); assert.equal(raw.passed.length, 3);
    assert.deepEqual(raw.rejected, evidence.reasonMatchedNegativeChecks); assert.equal(raw.rejected.length, 13);
    assert.equal(new Set(raw.rejected.map(row => row.name)).size, 13);
    for (const row of raw.rejected) { assert(new RegExp(row.reason).test(row.actual)); assert(!/EEXIST|ENOENT/.test(row.actual)); }
    assert.equal(raw.currentPhase.checked.length, 6); assert.equal(raw.currentPhase.mappings.length, 2);
    assert.equal(raw.nativeFinal.retainedBoundaryBindings.length, 21); assert.equal(raw.nativeFinal.existingSplitBindings.length, 4);
    assert.deepEqual(raw.nativeFinal.incoming, []); assert.equal(raw.failedActualCompilerCommands, 0);
    assert.equal(evidence.failedActualJobPidVerified, true); assert.equal(evidence.failedActualHead, 'ac407741ba2ad4157c3ec43d17a0176a3d1341b7');
    for (const name of ['newCompilerOrRuntimeCommandExecuted', 'fullCompilerBuilt', 'languageReadiness', 'recordedEarlySelectionFullyReexecuted', 'newWholePreparationClaimed']) assert.equal(evidence[name], false);
    assert.equal(evidence.historicalFilesReadOnly, true);
    const legacy = await historical(evidence.legacy.sourceSnapshotManifest);
    assert.equal(legacy.sourceLockSha256, evidence.legacy.sourceLockSha256); await pins(evidence.legacy.sourceSnapshotPins); await pins(evidence.legacy.executionPins);
    return { result: 'pass', mode: archiveMap ? 'archival-before-native-first-phase-exclusion' : 'original-phase-composition',
        executionIsHistorical: Boolean(archiveMap), currentExecutionClaimed: !archiveMap, checkedShippingInputPins: evidence.currentInputs.length, primaryOriginals: 3417,
        actualHistoricalSources: 3550, positives: 3, negatives: 13, artifacts: evidence.artifacts.length, legacy };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await verifyNativePhaseCompositionEvidence({ archiveManifest: process.argv[2] })));
