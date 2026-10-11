import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { assembleImports } from '../type-substitutor-getter/prepare.mjs';
import { normalizeImports } from '../descriptor-base-implementations/prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export const OUTPUT_PREFIX = 'compiler-port-descriptor-receiver-factory/';
function output(root) { assert(path.isAbsolute(root) && root.startsWith(path.join(REPO, 'out') + path.sep), 'Receiver factory output must be under out/'); }
function checked(body, pin) { assert.equal(body.length, pin.bytes, 'Receiver factory bytes changed: ' + pin.path); assert.equal(sha256(body), pin.sha256, 'Receiver factory SHA changed: ' + pin.path); return body; }
async function load(sourceRoot) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const primaryBytes = await readRegular(path.join(HERE, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
    assert.equal(lock.kind, 'genuine-descriptor-receiver-factory'); assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.primaryClosureSha256, sha256(primaryBytes)); assert.deepEqual(lock.source, primary.source);
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    const originals = [], common = [];
    for (const pin of lock.originals) { assert.deepEqual(pin, primary.files.find(row => row.path === pin.path)); originals.push(verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin)); }
    for (const pin of lock.common) common.push(verifyFile(await readRegular(path.join(HERE, pin.path)), pin));
    assert.deepEqual(lock.common.map(pin => pin.path), ['AbstractReceiverParameterDescriptor.kt', 'ReceiverParameterDescriptorImpl.kt', 'AbstractReceiverValue.kt', 'ExtensionReceiver.kt', 'TransientReceiver.kt', 'DescriptorFactory.kt']);
    return { lock, lockBytes, originals, common };
}
async function inventory(rows) {
    assert(Array.isArray(rows) && rows.length, 'Actual receiver factory selection required');
    const paths = new Set(), filenames = new Set(), result = [];
    for (const row of rows) {
        relativePath(row.path); assert(!paths.has(row.path), 'Duplicate receiver factory source path'); paths.add(row.path);
        assert(path.isAbsolute(row.filename) && !filenames.has(row.filename), 'Duplicate receiver factory owner'); filenames.add(row.filename);
        checked(await readRegular(row.filename), row); result.push({ path: row.path, filename: row.filename, bytes: row.bytes, sha256: row.sha256 });
    }
    return result;
}
function canonical(body, pin, imports) {
    const original = checked(normalizeImports(body, imports), pin);
    assert(body.equals(original) || body.equals(assembleImports(original, imports)), 'Unrecorded receiver dependency imports');
    return original;
}
async function bind(input, args, selected, imports) {
    const bindings = [];
    for (const expected of input.lock.bindings) {
        const supplied = args[expected.name]; assert(supplied?.outputRoot && supplied.receipt, 'Missing ' + expected.name);
        const root = path.resolve(supplied.outputRoot); output(root); await assertNoSymlink(root);
        const receiptPath = path.join(root, 'receipt.json'), bytes = await readRegular(receiptPath), receipt = JSON.parse(bytes);
        assert.deepEqual(receipt, supplied.receipt, 'Receiver predecessor object changed');
        assert.equal(receipt.kind, expected.kind); assert.equal(receipt.sourceLockSha256, expected.sourceLockSha256); assert.deepEqual(receipt.source, input.lock.source);
        const files = [];
        for (const pin of expected.files) {
            const record = receipt.files.find(row => row.path === pin.receiptPath); assert(record, 'Missing predecessor receipt file');
            assert.equal(record.bytes, pin.bytes); assert.equal(record.sha256, pin.sha256);
            const filename = path.join(root, pin.outputPath), row = selected.find(row => row.path === pin.path);
            assert(row, 'Missing receiver predecessor source'); assert.equal(row.filename, filename, 'Wrong receiver predecessor owner');
            files.push({ ...pin, filename, canonical: canonical(await readRegular(filename), pin, imports).toString('base64') });
        }
        bindings.push({ name: expected.name, outputRoot: root, receiptPath, receiptSha256: sha256(bytes), files });
    }
    return bindings;
}
async function replayBindings(input, bindings) {
    assert.equal(bindings.length, input.lock.bindings.length);
    for (const [i, binding] of bindings.entries()) {
        const expected = input.lock.bindings[i]; assert.equal(binding.name, expected.name); output(binding.outputRoot);
        assert.equal(binding.receiptPath, path.join(binding.outputRoot, 'receipt.json'));
        const bytes = await readRegular(binding.receiptPath), receipt = JSON.parse(bytes);
        assert.equal(sha256(bytes), binding.receiptSha256, 'Receiver predecessor receipt changed');
        assert.equal(receipt.kind, expected.kind); assert.equal(receipt.sourceLockSha256, expected.sourceLockSha256); assert.deepEqual(receipt.source, input.lock.source);
        assert.equal(binding.files.length, expected.files.length);
        for (const [j, file] of binding.files.entries()) {
            const { filename, canonical: encoded, ...pin } = file; assert.deepEqual(pin, expected.files[j]);
            assert.equal(filename, path.join(binding.outputRoot, pin.outputPath)); checked(Buffer.from(encoded, 'base64'), pin);
            const record = receipt.files.find(row => row.path === pin.receiptPath); assert(record); assert.equal(record.bytes, pin.bytes); assert.equal(record.sha256, pin.sha256);
        }
    }
}
async function checkBindings(bindings, selected, imports) {
    for (const binding of bindings) for (const pin of binding.files) {
        const row = selected.find(row => row.path === pin.path); assert(row, 'Missing receiver dependency'); assert.equal(row.filename, pin.filename, 'Wrong receiver dependency owner');
        const body = await readRegular(row.filename), original = Buffer.from(pin.canonical, 'base64');
        assert(body.equals(original) || body.equals(assembleImports(original, imports)), 'Receiver dependency body/imports changed');
    }
}
async function checkConsumers(input, consumerBindings, selected, imports) {
    assert.deepEqual(consumerBindings.map(row => row.path), input.lock.consumers);
    for (const bound of consumerBindings) {
        const row = selected.find(row => row.path === bound.path); assert(row, 'Missing retained genuine receiver consumer');
        assert.equal(row.filename, bound.filename, 'Wrong retained receiver consumer owner');
        const original = input.originals[input.lock.originals.findIndex(pin => pin.path === row.path)], body = await readRegular(row.filename);
        assert(body.equals(original) || body.equals(assembleImports(original, imports)), 'Retained receiver consumer changed');
    }
}
function receiptFor(input, bindings, consumerBindings, selectedInventory, recordedPropertyImports) {
    return { schemaVersion: 1, kind: 'genuine-descriptor-receiver-factory-preparation', source: input.lock.source, sourceLockSha256: sha256(input.lockBytes),
        files: input.lock.common.map(pin => ({ ...pin, path: OUTPUT_PREFIX + pin.path })), replacedOriginalPaths: input.lock.implementations,
        bindings, consumerBindings, selectedInventory, recordedPropertyImports,
        algorithms: ['complete AbstractReceiverParameterDescriptor', 'complete ReceiverParameterDescriptorImpl', 'complete AbstractReceiverValue', 'complete ExtensionReceiver', 'complete TransientReceiver', 'complete DescriptorFactory'],
        assertionsEnabled: true, requiredUnportedDependencies: ['PropertyAccessorDescriptorImpl', 'PropertyGetterDescriptorImpl', 'PropertySetterDescriptorImpl', 'PropertyDescriptorImpl', 'ClassConstructorDescriptorImpl'],
        rawJavaNullContractParity: false, fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareDescriptorReceiverFactory(args) {
    const sourceRoot = path.resolve(args.sourceRoot), outputRoot = path.resolve(args.outputRoot), imports = args.recordedPropertyImports ?? [];
    output(outputRoot); await assertNoSymlink(outputRoot);
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Receiver factory roots overlap');
    const input = await load(sourceRoot), selected = await inventory(args.retainedSources);
    assert(!selected.some(row => input.lock.implementations.includes(row.path) || row.path.startsWith(OUTPUT_PREFIX)), 'Original/duplicate receiver implementation selected');
    const bindings = await bind(input, args, selected, imports), consumerBindings = input.lock.consumers.map(logical => {
        const row = selected.find(row => row.path === logical); assert(row, 'Missing receiver consumer'); return { path: logical, filename: row.filename };
    });
    await checkConsumers(input, consumerBindings, selected, imports);
    const receipt = receiptFor(input, bindings, consumerBindings, selected, imports), commonSources = [];
    for (const [i, pin] of input.lock.originals.entries()) {
        const filename = path.join(outputRoot, 'reference', pin.path); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, input.originals[i], { flag: 'wx', mode: 0o600 });
    }
    for (const [i, pin] of receipt.files.entries()) {
        const filename = path.join(outputRoot, pin.path); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, input.common[i], { flag: 'wx', mode: 0o600 }); commonSources.push(filename);
    }
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath)), commonSources, replacedOriginalPaths: input.lock.implementations, predecessorBindings: [] };
}
async function replay(outputRoot, expectedReceiptSha256) {
    outputRoot = path.resolve(outputRoot); output(outputRoot); await assertNoSymlink(outputRoot);
    const input = await load(path.join(outputRoot, 'reference')), bytes = await readRegular(path.join(outputRoot, 'receipt.json'), 64 * 1024 * 1024), receipt = JSON.parse(bytes);
    assert.equal(sha256(bytes), expectedReceiptSha256, 'External receiver factory receipt SHA required');
    await replayBindings(input, receipt.bindings);
    assert.deepEqual(receipt, receiptFor(input, receipt.bindings, receipt.consumerBindings, receipt.selectedInventory, receipt.recordedPropertyImports));
    for (const bound of receipt.consumerBindings) assert.equal(bound.filename, receipt.selectedInventory.find(row => row.path === bound.path)?.filename, 'Receiver consumer binding changed');
    return { input, receipt, outputRoot };
}
export async function verifyDescriptorReceiverFactory({ outputRoot, expectedReceiptSha256 }) {
    const result = await replay(outputRoot, expectedReceiptSha256);
    const selected = await inventory(result.receipt.selectedInventory);
    await checkBindings(result.receipt.bindings, selected, result.receipt.recordedPropertyImports);
    await checkConsumers(result.input, result.receipt.consumerBindings, selected, result.receipt.recordedPropertyImports);
    for (const pin of result.receipt.files) verifyFile(await readRegular(path.join(result.outputRoot, pin.path)), pin);
    return result.receipt;
}
export async function verifyFinalDescriptorReceiverFactory({ outputRoot, expectedReceiptSha256, retainedSources, recordedPropertyImports = [] }) {
    const { input, receipt, outputRoot: root } = await replay(outputRoot, expectedReceiptSha256), selected = await inventory(retainedSources), checkedSources = [];
    await checkBindings(receipt.bindings, selected, recordedPropertyImports); await checkConsumers(input, receipt.consumerBindings, selected, recordedPropertyImports);
    assert(!selected.some(row => input.lock.implementations.includes(row.path)), 'Original Java receiver/factory selected');
    for (const [i, pin] of receipt.files.entries()) {
        const row = selected.find(row => row.path === pin.path); assert(row, 'Missing receiver/factory output'); assert.equal(row.filename, path.join(root, pin.path), 'Wrong receiver/factory owner');
        const original = input.common[i], bytes = await readRegular(row.filename);
        assert(bytes.equals(original) || bytes.equals(assembleImports(original, recordedPropertyImports)), 'Receiver/factory body/imports changed'); checkedSources.push(row);
    }
    assert.equal(selected.filter(row => row.path.startsWith(OUTPUT_PREFIX)).length, receipt.files.length, 'Unrecorded receiver/factory source');
    return { receipt: { schemaVersion: 1, kind: 'genuine-descriptor-receiver-factory-final', sourceLockSha256: sha256(input.lockBytes), checked: checkedSources,
        selectedSources: selected.length, removedFromPredecessorView: receipt.files.map(pin => pin.path), exactBodyAndOwnerVerified: true, fullCompilerBuilt: false, languageReadiness: false },
        predecessorRetainedSources: retainedSources.filter(row => !receipt.files.some(pin => pin.path === row.path)) };
}
