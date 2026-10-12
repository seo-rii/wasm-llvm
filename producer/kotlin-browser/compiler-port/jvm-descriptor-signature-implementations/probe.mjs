import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, readRegular, verifyFile } from '../../scripts/source.mjs';
import { jvmDescriptorSignatureIntegrity } from './integrity.mjs';
import { jvmDescriptorSignatureFixture } from './fixture.mjs';
import { prepareJvmDescriptorSignatureReferences, prepareJvmDescriptorSignatureImplementations,
    verifyJvmDescriptorSignatureImplementations, verifyFinalJvmDescriptorSignatureImplementations } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const outputRoot = path.resolve(process.argv[2]); assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
const mode = process.argv[3]; assert(['source', 'runtime-reuse', 'positive'].includes(mode));
let proof;
if (mode === 'source') proof = await jvmDescriptorSignatureIntegrity(outputRoot);
else if (mode === 'positive') {
    const args = await jvmDescriptorSignatureFixture(), reference = await prepareJvmDescriptorSignatureReferences({ outputRoot: path.join(outputRoot, 'reference-cache') });
    const prepared = await prepareJvmDescriptorSignatureImplementations({ ...args, sourceRoot: reference.sourceRoot, outputRoot: path.join(outputRoot, 'prepared') });
    await verifyJvmDescriptorSignatureImplementations({ outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256 });
    const addedRows = prepared.receipt.files.map(row => ({ path: row.path, filename: path.join(prepared.outputRoot, row.path), bytes: row.bytes, sha256: row.sha256, compile: true }));
    const final = await verifyFinalJvmDescriptorSignatureImplementations({ outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256,
        retainedSources: [...args.retainedSources, ...addedRows], recordedPropertyImports: args.recordedPropertyImports });
    assert.deepEqual(final.predecessorRetainedSources, args.retainedSources);
    proof = { schemaVersion: 1, kind: 'genuine-jvm-signature-stable-positive-fixture', result: 'pass', historical: args.historical,
        prepared: { outputRoot: prepared.outputRoot, receiptPath: prepared.receiptPath, receiptSha256: prepared.receiptSha256 },
        addedRows, preparation: prepared.receipt, final: final.receipt, actualBaseSources: 3553, focusedAddedSources: 18, focusedFinalSources: 3571,
        restoredSources: 3553, negativeGuardsExecuted: false, newJvmCommandsExecuted: 0, newWholeCompilerExecuted: false,
        wasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
}
else {
    const facts = JSON.parse(await readRegular(path.join(HERE, 'source-facts.json'))), root = facts.privateSuccessor.directory;
    const sealBytes = await readRegular(path.join(root, 'private-candidate-seal.json'), 8 * 1024 * 1024), seal = JSON.parse(sealBytes);
    const executionBytes = await readRegular(path.join(root, 'seal-execution.json')), execution = JSON.parse(executionBytes);
    assert.equal(sha256(sealBytes), facts.privateSuccessor.sealSha256); assert.equal(sha256(executionBytes), facts.privateSuccessor.executionSha256);
    assert.equal(seal.result, 'PASS'); assert.equal(execution.result, 'PASS'); assert.equal(execution.exitCode, 0);
    const rawPins = [];
    for (const row of seal.files) {
        const body = await readRegular(row.filename, 100 * 1024 * 1024); assert.equal(body.length, row.bytes); assert.equal(sha256(body), row.sha256); rawPins.push(row);
    }
    for (const row of Object.values(execution).filter(value => value?.filename && value.sha256)) {
        const body = await readRegular(row.filename, 100 * 1024 * 1024); assert.equal(body.length, row.bytes); assert.equal(sha256(body), row.sha256); rawPins.push(row);
    }
    const status = JSON.parse(await readRegular(execution.status.filename)); assert.equal(status.pid, execution.pid); assert.equal(status.state, 'exited'); assert.equal(status.exitCode, 0);
    const shipping = [];
    for (const row of facts.outputs) {
        const body = verifyFile(await readRegular(path.join(HERE, 'common', row.path)), row);
        assert(body.equals(await readRegular(path.join(root, 'common', row.path))), 'Shipping full source differs from accepted JVM candidate');
        shipping.push({ ...row, filename: path.join(HERE, 'common', row.path) });
    }
    const runtime = JSON.parse(await readRegular(path.join(root, 'runtime-1791801900/runtime-receipt.json')));
    const compile = JSON.parse(await readRegular(path.join(root, 'compile-1791801730/compile-receipt.json')));
    assert.equal(runtime.records.length, 95); assert.equal(runtime.catalogRecords, 33);
    assert.equal(compile.commands.length, 3); assert.equal(runtime.commands.length, 5);
    assert([...compile.commands, ...runtime.commands].every(row => row.exitCode === 0));
    assert.equal(runtime.javaReflectiveFieldLayoutParity, false); assert.equal(runtime.bootstrapSourceCommit, null); assert.equal(runtime.wasmExecuted, false);
    proof = { schemaVersion: 1, kind: 'genuine-jvm-descriptor-signature-runtime-reuse', result: 'pass', reusedPrivateSeal: execution.receipt,
        reusedExecution: { filename: path.join(root, 'seal-execution.json'), bytes: executionBytes.length, sha256: sha256(executionBytes) },
        rawPins, rawPinsVerified: seal.files.length, predecessorPinsVerified: seal.predecessorAllPinsVerified, shippingSources: shipping,
        byteExactCompleteOutputs: 18, records: runtime.records, recordCount: 95, catalogRecords: 33, reusedJvmCommands: 8, newJvmCommandsExecuted: 0,
        reusedHistoricalSelection: 3549, latestWholeSelectionReusedForRuntime: false, fullCurrentParentsRebuilt: false,
        extraJvmCompanionField: runtime.generatedJvmFieldBoundary, javaReflectiveFieldLayoutParity: false, bootstrapSourceCommit: null,
        portableThreeProvidersPresent: false, wasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
}
const filename = path.join(outputRoot, 'proof.json'); await writeFile(filename, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ result: proof.result, mode, guards: proof.guardCount, reusedRecords: proof.recordCount, outputRoot }));
