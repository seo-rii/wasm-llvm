import assert from 'node:assert/strict';
import { readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const PORT = path.dirname(HERE), MAX = 64 * 1024 * 1024;
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
async function pin(filename) { return { filename, ...identity(await readRegular(filename, MAX)) }; }
async function validate(pinRow) { assert.deepEqual(await pin(pinRow.filename), pinRow); }
async function files(directory) {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        assert(!entry.isSymbolicLink(), 'Evidence artifacts cannot be symlinks');
        if (entry.isDirectory()) result.push(...await files(filename));
        else { assert(entry.isFile()); result.push(filename); }
    }
    return result.sort();
}
async function batches(rows, action) {
    for (let index = 0; index < rows.length; index += 24) {
        const results = await Promise.allSettled(rows.slice(index, index + 24).map(action));
        for (const result of results) if (result.status !== 'fulfilled') throw result.reason;
    }
}

export async function sealNativePhaseComposition(jobFile) {
    const job = JSON.parse(await readRegular(jobFile)), status = JSON.parse(await readRegular(job.status));
    assert.equal(status.state, 'exited'); assert.equal(status.pid, job.pid); assert.equal(status.exitCode, 0);
    assert(job.output.startsWith(path.join(REPO, 'out/kotlin-native-phase-focused-')));
    const receiptFile = path.join(job.output, 'receipt.json'), receiptBytes = await readRegular(receiptFile, MAX), result = JSON.parse(receiptBytes);
    assert.equal(result.result, 'pass'); assert.equal(result.actualSelectedSources, 3550);
    assert.equal(result.failedActualCompilerCommands, 0); assert.equal(result.historicalFilesReadOnly, true);
    assert.equal(result.passed.length, 3); assert.equal(result.rejected.length, 13);
    assert.equal(new Set(result.rejected.map(row => row.name)).size, 13);
    for (const row of result.rejected) {
        assert(new RegExp(row.reason).test(row.actual)); assert(!/EEXIST|ENOENT/.test(row.actual));
    }
    await batches(result.inputs, validate);
    await batches(result.historicalSources, row => validate({ filename: row.filename, bytes: row.bytes, sha256: row.sha256 }));
    const failedJob = JSON.parse(await readRegular('/tmp/wasm-kotlin-class-phase-literal-whole-job.json'));
    const failedStatus = JSON.parse(await readRegular(failedJob.status));
    assert.equal(failedStatus.pid, failedJob.pid); assert.equal(failedStatus.state, 'exited'); assert.equal(failedStatus.exitCode, 1);
    assert.equal(failedJob.head, 'ac407741ba2ad4157c3ec43d17a0176a3d1341b7');
    assert.equal(result.nativeContextLineage.historicalWholeReceiptSha256, '75eaeab75292e1ec0c8fad8bc9c89c68b762f63f2c00f975e59e1528375c3520');
    assert.equal(result.nativeContextLineage.currentPrimarySourcesReinspected, 3417);
    assert.equal(result.nativeContextLineage.recordedEarlySelectionFullyReexecuted, false);
    assert.equal(result.nativeContextLineage.newWholePreparationClaimed, false);
    assert.equal(result.currentPhase.checked.length, 6); assert.equal(result.currentPhase.mappings.length, 2);
    assert.equal(result.nativeFinal.retainedBoundaryBindings.length, 21);
    assert.equal(result.nativeFinal.existingSplitBindings.length, 4); assert.deepEqual(result.nativeFinal.incoming, []);
    const collectorFile = '/tmp/kotlin-class-phase-input-capture.mjs', collectorPin = await pin(collectorFile);
    assert.equal(collectorPin.sha256, '64a20c2f8b30da5036e1d866c4c4549ce61115829a43e855b25d7dfa4f9d2fb9');
    const { captureShippingInputs } = await import(pathToFileURL(collectorFile).href);
    const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
    const current = await captureShippingInputs({ repository: REPO, portRoot: PORT,
        unitDirectories: ['native-js-output-profile', 'lowering-phase-factories', 'module-relative-paths'],
        extraFiles: [...lock.tools, ...lock.dependencies].map(row => path.resolve(HERE, row.path))
            .concat(['phase-composition.mjs', 'phase-composition-evidence.mjs', 'verify-phase.mjs', 'PHASE_PROOF.md', 'README.md', 'sources.lock.json'].map(name => path.join(HERE, name))) });
    const closure = JSON.parse(await readRegular(path.join(PORT, 'closure.lock.json'))), sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
    const primaryPins = closure.files.filter(row => row.compile && row.path.endsWith('.kt')).map(row => ({
        filename: path.join(sourceRoot, row.path), bytes: row.bytes, sha256: row.sha256, gitBlob: row.gitBlob, path: row.path }));
    assert.equal(primaryPins.length, 3417);
    await batches(primaryPins, async row => verifyFile(await readRegular(row.filename, MAX), row));
    const archiveManifest = '/tmp/kotlin-native-phase-before-edit.json', archive = JSON.parse(await readRegular(archiveManifest));
    const archiveReceiptFile = path.join(archive.outputRoot, 'receipt.json'), archiveReceipt = JSON.parse(await readRegular(archiveReceiptFile));
    assert.equal(archiveReceipt.files.length, 11); await batches(archiveReceipt.files, validate);
    const legacyFiles = ['evidence/integrity.json', 'evidence/receipt.json'];
    for (const name of legacyFiles) assert.deepEqual(await readRegular(path.join(HERE, name), MAX),
        await readRegular(path.join(archive.outputRoot, 'native-js-output-profile', name), MAX), 'Historical native evidence changed');
    const legacy = JSON.parse(await readRegular(path.join(HERE, 'evidence/receipt.json'), MAX));
    assert.deepEqual(legacy.executions.map(row => row.exitCode), [0, 0]);
    const legacyExecutionPins = [];
    for (const run of legacy.executions) {
        const state = JSON.parse(await readRegular(run.status)); assert.equal(state.exitCode, 0);
        for (const row of [run.statusPin, run.logPin, ...run.artifacts]) {
            const filename = row.path; assert.deepEqual(identity(await readRegular(filename, MAX)), { bytes: row.bytes, sha256: row.sha256 });
            legacyExecutionPins.push({ filename, bytes: row.bytes, sha256: row.sha256 });
        }
    }
    const artifacts = await Promise.all((await files(job.output)).map(pin));
    const executionPins = await Promise.all([jobFile, job.runner, job.log, job.status, collectorFile, archiveManifest, archiveReceiptFile].map(pin));
    const evidence = { schemaVersion: 1, kind: 'native-phase-final-composition-execution', result: 'pass',
        source: lock.source, sourceLockSha256: sha256(await readRegular(path.join(HERE, 'sources.lock.json'))),
        integrityPin: { filename: receiptFile, ...identity(receiptBytes) }, job, status, executionPins,
        currentInputs: current.inputPins, dependencyBindings: current.dependencyBindings,
        primaryOriginalPins: primaryPins, actualHistoricalRows: result.historicalSources, artifacts,
        failedActualJobPidVerified: true, failedActualHead: failedJob.head,
        positivePublicChecks: result.passed, reasonMatchedNegativeChecks: result.rejected,
        checkedPhaseOutputs: 6, overlappingCanonicalPhaseBoundaries: 2, retainedNativeBoundaries: 21,
        retainedNativeSplits: 4, unchangedHistoricalEvidence: legacyFiles,
        legacy: { executionIsHistorical: true, currentNoPhaseExecutionClaimed: false,
            sourceLockSha256: legacy.sourceLockSha256, sourceSnapshotManifest: archiveReceiptFile,
            sourceSnapshotPins: archiveReceipt.files, executionPins: legacyExecutionPins },
        recordedEarlySelectionFullyReexecuted: false, newWholePreparationClaimed: false,
        historicalFilesReadOnly: true, newCompilerOrRuntimeCommandExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
    for (const row of [...executionPins, ...current.inputPins, ...artifacts]) await validate(row);
    const evidenceDirectory = path.join(HERE, 'evidence'); await mkdir(evidenceDirectory, { recursive: true });
    await writeJson(path.join(evidenceDirectory, 'phase-composition.json'), result);
    await writeJson(path.join(evidenceDirectory, 'phase-composition-execution.json'), evidence);
    console.log(JSON.stringify({ result: 'pass', currentInputPins: current.inputPins.length,
        primaryOriginalPins: primaryPins.length, actualHistoricalRows: result.historicalSources.length,
        artifacts: artifacts.length, historicalLegacyExecutionPins: legacyExecutionPins.length,
        negatives: result.rejected.length, positives: result.passed.length }));
    return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    assert.equal(process.argv.length, 3, 'Usage: phase-composition-evidence.mjs COMPLETED_JOB_MANIFEST');
    await sealNativePhaseComposition(process.argv[2]);
}
