import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { assembleImports } from '../type-substitutor-getter/prepare.mjs';
import { normalizeImports } from '../descriptor-base-implementations/prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export const OUTPUT_PREFIX = 'compiler-port-descriptor-functions/';
const componentNames = ['preparedDescriptorBases', 'preparedCopyBuilderPlatform', 'preparedTypeImplementations'];
const rootCheck = root => assert(path.isAbsolute(root) && root.startsWith(path.join(REPO, 'out') + path.sep), 'Function component output must be under out/');
const checked = (bytes, pin) => { assert.equal(bytes.length, pin.bytes, 'Function source bytes changed: ' + pin.path); assert.equal(sha256(bytes), pin.sha256, 'Function source SHA changed: ' + pin.path); return bytes; };

async function load(sourceRoot) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const primaryBytes = await readRegular(path.join(HERE, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
    assert.equal(lock.kind, 'genuine-descriptor-function-implementations'); assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.primaryClosureSha256, sha256(primaryBytes)); assert.deepEqual(lock.source, primary.source);
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    const originals = [];
    for (const pin of lock.originals) { assert.deepEqual(pin, primary.files.find(item => item.path === pin.path)); originals.push(verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin)); }
    const common = [];
    for (const pin of lock.common) common.push(verifyFile(await readRegular(path.join(HERE, pin.path)), pin));
    assert.deepEqual(lock.common.map(pin => pin.path), ['FunctionDescriptorImpl.kt', 'SimpleFunctionDescriptorImpl.kt', 'FunctionDescriptorProperties.kt']);
    assert.deepEqual(lock.bindings.map(binding => binding.name), componentNames);
    return { lock, lockBytes, originals, common };
}
async function inventory(rows) {
    assert(Array.isArray(rows) && rows.length > 0, 'Actual function preparation selection required');
    const paths = new Set(), filenames = new Set(), result = [];
    for (const row of rows) {
        relativePath(row.path); assert(!paths.has(row.path), 'Duplicate function selection path'); paths.add(row.path);
        assert(path.isAbsolute(row.filename) && !filenames.has(row.filename), 'Duplicate function selection filename'); filenames.add(row.filename);
        checked(await readRegular(row.filename), row);
        result.push({ path: row.path, filename: row.filename, bytes: row.bytes, sha256: row.sha256 });
    }
    return result;
}
async function canonical(bytes, pin, imports) {
    if (bytes.length === pin.bytes && sha256(bytes) === pin.sha256) return bytes;
    const original = checked(pin.path.startsWith('compiler-port-type-implementation/common/')
        ? await readRegular(path.join(HERE, '../type-implementation', path.basename(pin.path)))
        : normalizeImports(bytes, imports), pin);
    assert.deepEqual(assembleImports(original, imports), bytes, 'Unrecorded function assembly imports'); return original;
}
async function bind(input, supplied, selection, imports) {
    const bindings = [];
    for (const specification of input.lock.bindings) {
        const component = supplied[specification.name]; assert(component?.outputRoot && component.receipt, 'Missing ' + specification.name);
        const outputRoot = path.resolve(component.outputRoot); rootCheck(outputRoot); await assertNoSymlink(outputRoot);
        const receiptPath = path.join(outputRoot, 'receipt.json'), bytes = await readRegular(receiptPath), receipt = JSON.parse(bytes);
        assert.deepEqual(receipt, component.receipt, 'Supplied function predecessor receipt changed');
        assert.equal(receipt.kind, specification.kind); assert.equal(receipt.sourceLockSha256, specification.sourceLockSha256); assert.deepEqual(receipt.source, input.lock.source);
        const files = [];
        for (const expected of specification.files) {
            const pin = receipt.files.find(pin => pin.path === expected.receiptPath); assert(pin, 'Missing function predecessor pin');
            assert.equal(pin.bytes, expected.bytes); assert.equal(pin.sha256, expected.sha256);
            const filename = path.join(outputRoot, expected.outputPath), selected = selection.find(row => row.path === expected.path);
            assert(selected, 'Missing function predecessor selection'); assert.equal(selected.filename, filename, 'Wrong function predecessor owner');
            const body = await canonical(await readRegular(filename), expected, imports);
            files.push({ ...expected, filename, canonical: body.toString('base64') });
        }
        bindings.push({ name: specification.name, outputRoot, receiptPath, receiptSha256: sha256(bytes), files });
    }
    return bindings;
}
async function replayBindings(input, bindings) {
    assert.equal(bindings.length, input.lock.bindings.length);
    for (const [i, binding] of bindings.entries()) {
        const specification = input.lock.bindings[i]; assert.equal(binding.name, specification.name); rootCheck(binding.outputRoot);
        assert.equal(binding.receiptPath, path.join(binding.outputRoot, 'receipt.json'));
        const bytes = await readRegular(binding.receiptPath), receipt = JSON.parse(bytes); assert.equal(sha256(bytes), binding.receiptSha256, 'Function predecessor receipt changed');
        assert.equal(receipt.kind, specification.kind); assert.equal(receipt.sourceLockSha256, specification.sourceLockSha256); assert.deepEqual(receipt.source, input.lock.source);
        assert.equal(binding.files.length, specification.files.length);
        for (const [j, file] of binding.files.entries()) {
            const { filename, canonical: encoded, ...pin } = file, expected = specification.files[j]; assert.deepEqual(pin, expected);
            assert.equal(filename, path.join(binding.outputRoot, expected.outputPath)); checked(Buffer.from(encoded, 'base64'), expected);
            const pinned = receipt.files.find(pin => pin.path === expected.receiptPath); assert(pinned); assert.equal(pinned.bytes, expected.bytes); assert.equal(pinned.sha256, expected.sha256);
        }
    }
}
async function checkRelevant(bindings, rows, imports) {
    for (const binding of bindings) for (const file of binding.files) {
        const row = rows.find(row => row.path === file.path); assert(row, 'Missing genuine function dependency');
        assert.equal(row.filename, file.filename, 'Wrong genuine function dependency owner');
        const bytes = await readRegular(row.filename), original = Buffer.from(file.canonical, 'base64');
        assert(bytes.equals(original) || bytes.equals(assembleImports(original, imports)), 'Genuine function dependency body/imports changed');
    }
}
function receiptFor(input, bindings, consumerBindings, selectedInventory, recordedPropertyImports) {
    return { schemaVersion: 1, kind: 'genuine-descriptor-function-preparation', source: input.lock.source, sourceLockSha256: sha256(input.lockBytes),
        files: input.lock.common.map(pin => ({ ...pin, path: OUTPUT_PREFIX + pin.path })), replacedOriginalPaths: input.lock.implementations,
        bindings, consumerBindings, selectedInventory, recordedPropertyImports,
        algorithms: ['complete FunctionDescriptorImpl', 'complete SimpleFunctionDescriptorImpl'],
        requiredUnportedDependencies: ['DescriptorFactory', 'DescriptorSubstitutor', 'ReceiverParameterDescriptorImpl'],
        initializedNullReturnTypeBuilderSetPreserved: true, initializedNullModalityBuilderCopyParity: false,
        nullModalityFailureStage: 'virtual getModality() before builder setModality can replace null',
        rawJavaNullContractParity: false, crossThreadVolatileParity: false, innerFieldBinaryVisibilityParity: false,
        fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareDescriptorFunctionImplementations(args) {
    const sourceRoot = path.resolve(args.sourceRoot), outputRoot = path.resolve(args.outputRoot), imports = args.recordedPropertyImports ?? [];
    rootCheck(outputRoot); await assertNoSymlink(outputRoot);
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Function source/output roots overlap');
    const input = await load(sourceRoot), selected = await inventory(args.retainedSources);
    assert(!selected.some(row => input.lock.implementations.includes(row.path) || row.path.startsWith(OUTPUT_PREFIX)), 'Function implementation reintroduced before preparation');
    const bindings = await bind(input, args, selected, imports), consumerBindings = [];
    for (const logical of input.lock.consumers) {
        const row = selected.find(row => row.path === logical); assert(row, 'Missing genuine writable-property consumer');
        const index = input.lock.originals.findIndex(pin => pin.path === logical), original = input.originals[index], bytes = await readRegular(row.filename);
        assert(bytes.equals(original) || bytes.equals(assembleImports(original, imports)), 'Genuine writable-property consumer changed');
        consumerBindings.push({ path: logical, filename: row.filename });
    }
    const receipt = receiptFor(input, bindings, consumerBindings, selected, imports), commonSources = [];
    for (const [i, pin] of input.lock.originals.entries()) {
        const target = path.join(outputRoot, 'reference', pin.path); await assertNoSymlink(target); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, input.originals[i], { flag: 'wx', mode: 0o600 });
    }
    for (const [i, pin] of receipt.files.entries()) {
        const target = path.join(outputRoot, pin.path); await assertNoSymlink(target); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, input.common[i], { flag: 'wx', mode: 0o600 }); commonSources.push(target);
    }
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath)), commonSources, replacedOriginalPaths: input.lock.implementations, predecessorBindings: [] };
}
async function replay(outputRoot, expectedReceiptSha256) {
    outputRoot = path.resolve(outputRoot); rootCheck(outputRoot); await assertNoSymlink(outputRoot);
    const input = await load(path.join(outputRoot, 'reference')), bytes = await readRegular(path.join(outputRoot, 'receipt.json'), 64 * 1024 * 1024), receipt = JSON.parse(bytes);
    assert.equal(sha256(bytes), expectedReceiptSha256, 'Function preparation receipt pin required and must match');
    await replayBindings(input, receipt.bindings);
    assert.deepEqual(receipt, receiptFor(input, receipt.bindings, receipt.consumerBindings, receipt.selectedInventory, receipt.recordedPropertyImports));
    assert.deepEqual(receipt.consumerBindings.map(row => row.path), input.lock.consumers);
    for (const row of receipt.consumerBindings) {
        assert(path.isAbsolute(row.filename)); assert.equal(row.filename, receipt.selectedInventory.find(item => item.path === row.path)?.filename, 'Consumer owner binding changed');
    }
    return { input, receipt, outputRoot };
}
export async function verifyDescriptorFunctionImplementations({ outputRoot, expectedReceiptSha256 }) {
    const result = await replay(outputRoot, expectedReceiptSha256);
    await inventory(result.receipt.selectedInventory); await checkConsumers(result.input, result.receipt, result.receipt.selectedInventory, result.receipt.recordedPropertyImports); await checkRelevant(result.receipt.bindings, result.receipt.selectedInventory, result.receipt.recordedPropertyImports);
    for (const pin of result.receipt.files) verifyFile(await readRegular(path.join(result.outputRoot, pin.path)), pin);
    return result.receipt;
}
export async function verifyFinalDescriptorFunctionImplementations({ outputRoot, expectedReceiptSha256, retainedSources, recordedPropertyImports = [] }) {
    const { input, receipt, outputRoot: root } = await replay(outputRoot, expectedReceiptSha256), selected = await inventory(retainedSources), checkedSources = [];
    await checkRelevant(receipt.bindings, selected, recordedPropertyImports); await checkConsumers(input, receipt, selected, recordedPropertyImports);
    assert(!selected.some(row => input.lock.implementations.includes(row.path)), 'Original Java function implementation was reintroduced');
    for (const pin of receipt.files) {
        const row = selected.find(row => row.path === pin.path); assert(row, 'Missing function implementation output');
        assert.equal(row.filename, path.join(root, pin.path), 'Wrong function implementation owner');
        const original = input.common[receipt.files.indexOf(pin)], bytes = await readRegular(row.filename);
        assert(bytes.equals(original) || bytes.equals(assembleImports(original, recordedPropertyImports)), 'Function implementation body/imports changed'); checkedSources.push(row);
    }
    assert.equal(selected.filter(row => row.path.startsWith(OUTPUT_PREFIX)).length, receipt.files.length, 'Unrecorded function component output');
    return { receipt: { schemaVersion: 1, kind: 'genuine-descriptor-function-final', sourceLockSha256: sha256(input.lockBytes),
        checked: checkedSources, selectedSources: selected.length, removedFromPredecessorView: receipt.files.map(pin => pin.path),
        exactBodyAndOwnerVerified: true, fullCompilerBuilt: false, languageReadiness: false },
        predecessorRetainedSources: retainedSources.filter(row => !receipt.files.some(pin => pin.path === row.path)) };
}

async function checkConsumers(input, receipt, selected, imports) {
    for (const bound of receipt.consumerBindings) {
        const row = selected.find(row => row.path === bound.path); assert(row, 'Missing genuine writable-property consumer');
        assert.equal(row.filename, bound.filename, 'Wrong genuine writable-property consumer owner');
        const original = input.originals[input.lock.originals.findIndex(pin => pin.path === row.path)], bytes = await readRegular(row.filename);
        assert(bytes.equals(original) || bytes.equals(assembleImports(original, imports)), 'Genuine writable-property consumer changed');
    }
}
