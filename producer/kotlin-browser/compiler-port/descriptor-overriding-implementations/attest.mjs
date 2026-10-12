import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { overridingImplementationFixture } from './fixture.mjs';
import { OUTPUT_PREFIX, verifyDescriptorOverridingImplementations, verifyFinalDescriptorOverridingImplementations } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const mode = process.argv[2], manifestFile = path.resolve(process.argv[3]), outputRoot = path.resolve(process.argv[4]);
assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(outputRoot, { mode: 0o700 });
const manifestBytes = await readRegular(manifestFile), job = JSON.parse(manifestBytes), statusBytes = await readRegular(job.status), status = JSON.parse(statusBytes);
assert.equal(status.state, 'exited'); assert.equal(status.exitCode, 0);
const proofFile = path.join(job.output, 'proof.json'), proofBytes = await readRegular(proofFile, 64 * 1024 * 1024), proof = JSON.parse(proofBytes); assert.equal(proof.result, 'pass');
const checked = [];
async function pin(filename) { const bytes = await readRegular(filename, 64 * 1024 * 1024); checked.push({ filename, bytes: bytes.length, sha256: sha256(bytes) }); }
async function frozen(bytes, record) { assert.equal(bytes.length, record.bytes); assert.equal(sha256(bytes), record.sha256); }
await pin(fileURLToPath(import.meta.url)); await pin(path.join(HERE, 'sources.lock.json')); await pin(manifestFile); await pin(job.status); await pin(job.log); await pin(proofFile);
if (mode === 'source') {
    assert.equal(job.proofMode, 'source'); const args = await overridingImplementationFixture(), root = path.join(job.output, 'prepared');
    const receiptBytes = await readRegular(path.join(root, 'receipt.json'), 64 * 1024 * 1024), receipt = JSON.parse(receiptBytes);
    assert.deepEqual(receipt, proof.preparation); const options = { outputRoot: root, expectedReceiptSha256: sha256(receiptBytes), recordedPropertyImports: args.recordedPropertyImports };
    await verifyDescriptorOverridingImplementations(options);
    const rows = args.retainedSources.map(row => { const replacement = receipt.files.find(p => p.path === row.path); return replacement ? { ...row, filename: path.join(root, row.path), bytes: replacement.bytes, sha256: replacement.sha256 } : row; });
    for (const p of receipt.files.filter(p => p.path.startsWith(OUTPUT_PREFIX))) rows.push({ path: p.path, filename: path.join(root, p.path), bytes: p.bytes, sha256: p.sha256, compile: true });
    const final = await verifyFinalDescriptorOverridingImplementations({ ...options, retainedSources: rows }); assert.deepEqual(final.receipt, proof.final); assert.deepEqual(final.predecessorRetainedSources, args.retainedSources);
    assert.equal(proof.guardCount, proof.guards.length); assert(proof.guards.length >= 20 && proof.guards.every(g => g.result === 'rejected')); assert.equal(proof.restoredPositive, true);
    await pin(path.join(root, 'receipt.json')); for (const p of receipt.files) await pin(path.join(root, p.path));
} else if (mode === 'runtime-reuse') {
    assert.equal(job.proofMode, 'runtime-reuse'); assert.equal(proof.newJvmCommandsExecuted, 0);
    const bytes = await readRegular(proof.rawProof.filename, 64 * 1024 * 1024); await frozen(bytes, proof.rawProof); const raw = JSON.parse(bytes); assert(raw.commands.every(c => c.exitCode === 0));
    for (const p of raw.inputPins) await frozen(await readRegular(p.filename), p);
    const sealBytes = await readRegular(proof.privateSeal.filename); await frozen(sealBytes, proof.privateSeal); const seal = JSON.parse(sealBytes), draft = path.dirname(proof.privateSeal.filename);
    for (const p of seal.files) await frozen(await readRegular(p.filename ?? path.join(draft, p.path)), p);
    for (const p of proof.shippingMatches) await frozen(await readRegular(path.join(HERE, p.path)), p);
    assert.equal(raw.recordCount, 32); assert.equal(raw.controlledProviderRecordCount, 12); assert.equal(raw.constructorFailureRecords.length, 2);
} else throw new Error('Unknown overriding attestation mode');
await writeJson(path.join(outputRoot, 'proof.json'), { schemaVersion: 1, kind: 'genuine-descriptor-overriding-completed-proof-attestation', result: 'pass', mode, checked,
    priorJob: { manifestFile, supervisorPid: job.pid, statusHadPidField: Object.hasOwn(status, 'pid'), recordedExitCode: status.exitCode, outputRoot: job.output },
    originalStatusAndLogModified: false, sourceGuardSuiteRerun: false, newJvmCommandsExecuted: 0, fullCompilerBuilt: false, fullCommonClassWasmExecuted: false, languageReadiness: false });
console.log(JSON.stringify({ result: 'pass', mode, outputRoot, originalStatusAndLogModified: false }));
