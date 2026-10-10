import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sha256 } from '../../scripts/source.mjs';
import { guardBinaryReaderReferences, prepareBinaryReaderProfile, verifyBinaryReaderProfile, READER } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const parent = path.join(REPO, 'out/kotlin-binary-reader-profile-guards');
const original = await readFile(path.join(sourceRoot, READER));
const snapshotPin = (logical, bytes) => ({ path: logical, bytes: bytes.length, sha256: sha256(bytes), source: bytes.toString('base64') });
const own = snapshotPin(READER, original);

async function fixture() {
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(path.join(parent, 'run-'));
    const caller = path.join(root, 'BrowserCompilerPipeline.kt');
    const bytes = Buffer.from('package org.jetbrains.kotlin.browser.compiler\nclass BrowserCompilerPipeline\n');
    await writeFile(caller, bytes);
    const retainedSources = [
        { path: READER, filename: path.join(sourceRoot, READER), bytes: original.length, sha256: sha256(original) },
        { path: 'compiler-port-entry/BrowserCompilerPipeline.kt', filename: caller, bytes: bytes.length, sha256: sha256(bytes) },
    ];
    return { root, retainedSources, options: { sourceRoot, outputRoot: path.join(root, 'prepared'), retainedSources } };
}

test('preparation preserves the complete original and re-verifies frozen inputs', async () => {
    const { options } = await fixture();
    const component = await prepareBinaryReaderProfile(options);
    const verified = await verifyBinaryReaderProfile(path.dirname(component.receiptPath));
    assert.deepEqual(component.commonSources, []);
    assert.deepEqual(verified.sourceSetExclusions, [READER]);
    assert.equal(verified.receipt.exclusionGuard.inspectedKotlinInputs, 2);
    assert.equal(verified.receipt.languageReadiness, false);
    assert.equal(verified.receipt.algorithmsReplaced, false);
    assert.deepEqual(await readFile(path.join(path.dirname(component.receiptPath), 'original', READER)), original);
    await assert.rejects(prepareBinaryReaderProfile(options), /EEXIST/);
});

test('direct, qualified, alias, wildcard, string and comment references fail closed', () => {
    for (const text of [
        'package org.jetbrains.kotlin.wasm.ir.convertors\nval reader: ByteReader? = null',
        'package test\nval reader = org.jetbrains.kotlin.wasm.ir.convertors.MyByteReader(bytes)',
        'package test\nimport org.jetbrains.kotlin.wasm.ir.convertors.MyByteReader as Reader\nval r = Reader(bytes)',
        'package test\nimport org.jetbrains.kotlin.wasm.ir.convertors.*\nval r: WasmBinaryToIR? = null',
        'package test\nval opcode = twoByteOpcodes',
        'package test\nval reflectiveName = "WasmBinaryToIR"',
        'package test\n// MyByteReader dependency needs review',
    ]) assert.throws(() => guardBinaryReaderReferences([own, snapshotPin('entry/Test.kt', Buffer.from(text))], original), /Retained binary-reader reference/);
});

test('IC deserializer, changed declarations, duplicate paths and missing original are rejected', () => {
    assert.throws(() => guardBinaryReaderReferences([own, snapshotPin('compiler/ir/backend.wasm/src/org/jetbrains/kotlin/backend/wasm/serialization/WasmDeserializer.kt', Buffer.from('package test'))], original), /deserializer is selected/);
    assert.throws(() => guardBinaryReaderReferences([snapshotPin(READER, Buffer.concat([original, Buffer.from('\nclass ExtraReader\n')]))], original), /Reader body changed/);
    assert.throws(() => guardBinaryReaderReferences([own, own], original), /Duplicate/);
    assert.throws(() => guardBinaryReaderReferences([snapshotPin('entry/Test.kt', Buffer.from('package test'))], original), /exactly once/);
    const imports = Buffer.from(original.toString().replace('package org.jetbrains.kotlin.wasm.ir.convertors', 'package org.jetbrains.kotlin.wasm.ir.convertors\nimport org.jetbrains.kotlin.portable.builtins.*'));
    assert.equal(guardBinaryReaderReferences([snapshotPin(READER, imports)], original).originalReaderInputs, 1);
});

test('late browser-entry changes and frozen snapshot mutations cannot reuse evidence', async () => {
    const { options, retainedSources } = await fixture();
    await writeFile(retainedSources[1].filename, 'package test\nval r: ByteReader? = null\n');
    await assert.rejects(prepareBinaryReaderProfile(options), /Selected source/);
    const bytes = await readFile(retainedSources[1].filename);
    retainedSources[1] = { ...retainedSources[1], bytes: bytes.length, sha256: sha256(bytes) };
    await assert.rejects(prepareBinaryReaderProfile({ ...options, retainedSources }), /Retained binary-reader reference/);
});

test('receipts cannot assert readiness, remove the exclusion or conceal changed references', async () => {
    const { options } = await fixture(); const component = await prepareBinaryReaderProfile(options);
    const root = path.dirname(component.receiptPath); const receiptBytes = await readFile(component.receiptPath);
    for (const changes of [{ languageReadiness: true }, { sourceSetExclusions: [] }, { exclusionGuard: { incomingReferences: [] } }]) {
        await writeFile(component.receiptPath, JSON.stringify({ ...JSON.parse(receiptBytes), ...changes }));
        await assert.rejects(verifyBinaryReaderProfile(root), /receipt changed/);
    }
    await writeFile(component.receiptPath, receiptBytes);
    const snapshot = path.join(root, 'retained-source-snapshot.json.gz');
    const bytes = await readFile(snapshot); bytes[bytes.length - 1] ^= 1; await writeFile(snapshot, bytes);
    await assert.rejects(verifyBinaryReaderProfile(root));
});

test('changed original references, symlinks and both overlap directions are rejected', async () => {
    const { root, options } = await fixture();
    const changedRoot = path.join(root, 'changed'); const changed = path.join(changedRoot, READER);
    await mkdir(path.dirname(changed), { recursive: true }); await writeFile(changed, Buffer.concat([original, Buffer.from('\n')]));
    await assert.rejects(prepareBinaryReaderProfile({ ...options, sourceRoot: changedRoot }), /Pinned source/);
    const linkedRoot = path.join(root, 'linked'); await symlink(sourceRoot, linkedRoot);
    await assert.rejects(prepareBinaryReaderProfile({ ...options, sourceRoot: linkedRoot }), /Symlink/);
    await assert.rejects(prepareBinaryReaderProfile({ ...options, outputRoot: sourceRoot }), /overlap/);
    await assert.rejects(prepareBinaryReaderProfile({ ...options, outputRoot: path.join(sourceRoot, 'nested') }), /overlap/);
    await assert.rejects(prepareBinaryReaderProfile({ ...options, outputRoot: path.dirname(sourceRoot) }), /overlap/);
});
