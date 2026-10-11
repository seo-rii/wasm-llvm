import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { assembleImports } from '../type-substitutor-getter/prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export const OUTPUT_PREFIX = 'compiler-port-descriptor-substitutor/';
const names = ['DescriptorSubstitutor.kt', 'AbstractTypeParameterDescriptor.kt', 'TypeParameterDescriptorImpl.kt', 'TypeParameterProperties.kt'];
const rootCheck = root => assert(path.isAbsolute(root) && root.startsWith(path.join(REPO, 'out') + path.sep), 'Descriptor substitution output must be under out/');

async function load(sourceRoot) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'genuine-descriptor-substitution-family');
    assert.equal(lock.primaryClosureSha256, sha256(closureBytes)); assert.deepEqual(lock.source, closure.source);
    assert.deepEqual(lock.common.map(pin => pin.path), names);
    assert.deepEqual(lock.implementations, [
        'core/descriptors/src/org/jetbrains/kotlin/types/DescriptorSubstitutor.java',
        'core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/AbstractTypeParameterDescriptor.java',
        'core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/TypeParameterDescriptorImpl.java',
    ]);
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    const originals = new Map();
    for (const pin of lock.originals) {
        assert.deepEqual(pin, closure.files.find(row => row.path === pin.path));
        originals.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin));
    }
    const common = new Map();
    for (const pin of lock.common) common.set(pin.path, verifyFile(await readRegular(path.join(HERE, pin.path)), pin));
    for (const binding of lock.bindings) for (const pin of binding.files) verifyFile(await readRegular(path.join(HERE, pin.localPath)), pin);
    return { lock, lockBytes, originals, common };
}
async function inventory(rows) {
    assert(Array.isArray(rows) && rows.length, 'Actual descriptor substitution selection required');
    const paths = new Set(), filenames = new Set(), result = [];
    for (const row of rows) {
        relativePath(row.path); assert(!paths.has(row.path), 'Duplicate substitution logical path'); paths.add(row.path);
        assert(path.isAbsolute(row.filename) && !filenames.has(row.filename), 'Duplicate substitution owner'); filenames.add(row.filename);
        const bytes = await readRegular(row.filename);
        assert.equal(bytes.length, row.bytes, 'Substitution selection bytes changed'); assert.equal(sha256(bytes), row.sha256, 'Substitution selection SHA changed');
        result.push({ path: row.path, filename: row.filename, bytes: row.bytes, sha256: row.sha256 });
    }
    return result;
}
async function checkRelevant(input, bindings, originalOwners, rows, imports) {
    for (const [i, binding] of bindings.entries()) {
        const specification = input.lock.bindings[i]; assert.equal(binding.name, specification.name); rootCheck(binding.outputRoot);
        assert.equal(binding.receiptPath, path.join(binding.outputRoot, 'receipt.json'));
        const bytes = await readRegular(binding.receiptPath), receipt = JSON.parse(bytes);
        assert.equal(sha256(bytes), binding.receiptSha256, 'Substitution predecessor receipt changed');
        assert.equal(receipt.kind, specification.kind); assert.deepEqual(receipt.source, input.lock.source);
        assert.equal(receipt.sourceLockSha256, specification.sourceLockSha256);
        for (const pin of specification.files) {
            const receiptPin = receipt.files.find(row => row.path === pin.receiptPath);
            assert(receiptPin, 'Missing substitution predecessor artifact'); assert.equal(receiptPin.bytes, pin.bytes); assert.equal(receiptPin.sha256, pin.sha256);
            const row = rows.find(row => row.path === pin.path); assert(row, 'Missing substitution predecessor selection');
            assert.equal(row.filename, path.join(binding.outputRoot, pin.outputPath), 'Wrong substitution predecessor owner');
            const original = await readRegular(path.join(HERE, pin.localPath)), actual = await readRegular(row.filename);
            assert(actual.equals(original) || actual.equals(assembleImports(original, imports)), 'Substitution predecessor body/imports changed');
        }
    }
    assert.equal(bindings.length, input.lock.bindings.length);
    assert.deepEqual(originalOwners.map(row => row.path), input.lock.consumers);
    for (const owner of originalOwners) {
        const row = rows.find(row => row.path === owner.path); assert(row, 'Missing genuine substitution consumer');
        assert.equal(row.filename, owner.filename, 'Wrong genuine substitution consumer owner');
        const original = input.originals.get(row.path), actual = await readRegular(row.filename);
        assert(actual.equals(original) || actual.equals(assembleImports(original, imports)), 'Genuine substitution consumer body/imports changed');
    }
}
function receiptFor(input, bindings, originalOwners, selectedInventory, recordedPropertyImports) {
    return { schemaVersion: 1, kind: 'genuine-descriptor-substitution-preparation', source: input.lock.source, sourceLockSha256: sha256(input.lockBytes),
        files: input.lock.common.map(pin => ({ ...pin, path: OUTPUT_PREFIX + pin.path })), replacedOriginalPaths: input.lock.implementations,
        bindings, originalOwners, selectedInventory, recordedPropertyImports,
        preserved: ['complete two-pass substitution', 'nullable bound substitution failure and partial result state', 'recursive-bound approximation selection',
            'lazy type constructor and member scope', 'initialization and upper-bound mutation guards', 'cycle reporting and classifier equivalence',
            'reference-sensitive change flag and duplicate-descriptor map behavior'],
        javaVoidCallbackReturnMapping: 'Nothing?; invocation retained, non-null Java Void objects excluded',
        javaPlatformNullAndCollectionMutationParity: false, crossThreadLazyPublicationParity: false,
        fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareDescriptorSubstitutor(args) {
    const sourceRoot = path.resolve(args.sourceRoot), outputRoot = path.resolve(args.outputRoot), imports = args.recordedPropertyImports ?? [];
    rootCheck(outputRoot); await assertNoSymlink(outputRoot);
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Substitution source/output roots overlap');
    const input = await load(sourceRoot), rows = await inventory(args.retainedSources), bindings = [];
    assert(!rows.some(row => input.lock.implementations.includes(row.path) || row.path.startsWith(OUTPUT_PREFIX)), 'Substitution source already selected');
    for (const specification of input.lock.bindings) {
        const supplied = args[specification.name]; assert(supplied?.outputRoot && supplied.receipt, 'Missing ' + specification.name);
        const root = path.resolve(supplied.outputRoot); rootCheck(root); await assertNoSymlink(root);
        const receiptPath = path.join(root, 'receipt.json'), bytes = await readRegular(receiptPath);
        assert.deepEqual(JSON.parse(bytes), supplied.receipt, 'Supplied substitution predecessor receipt changed');
        bindings.push({ name: specification.name, outputRoot: root, receiptPath, receiptSha256: sha256(bytes) });
    }
    const originalOwners = input.lock.consumers.map(logical => {
        const row = rows.find(row => row.path === logical); assert(row, 'Missing substitution consumer');
        return { path: logical, filename: row.filename };
    });
    await checkRelevant(input, bindings, originalOwners, rows, imports);
    const receipt = receiptFor(input, bindings, originalOwners, rows, imports), commonSources = [];
    for (const [logical, bytes] of input.originals) {
        const filename = path.join(outputRoot, 'reference', logical); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { mode: 0o600, flag: 'wx' });
    }
    for (const [name, bytes] of input.common) {
        const filename = path.join(outputRoot, OUTPUT_PREFIX + name); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { mode: 0o600, flag: 'wx' }); commonSources.push(filename);
    }
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath)), commonSources, replacedOriginalPaths: input.lock.implementations };
}
async function replay(outputRoot, expectedReceiptSha256) {
    outputRoot = path.resolve(outputRoot); rootCheck(outputRoot); await assertNoSymlink(outputRoot);
    const input = await load(path.join(outputRoot, 'reference')), bytes = await readRegular(path.join(outputRoot, 'receipt.json'), 64 * 1024 * 1024), receipt = JSON.parse(bytes);
    assert.equal(sha256(bytes), expectedReceiptSha256, 'Immutable substitution receipt pin required');
    assert.deepEqual(receipt, receiptFor(input, receipt.bindings, receipt.originalOwners, receipt.selectedInventory, receipt.recordedPropertyImports));
    const rows = receipt.selectedInventory;
    assert(Array.isArray(rows) && rows.length); const paths = new Set(), owners = new Set();
    for (const row of rows) { relativePath(row.path); assert(!paths.has(row.path)); paths.add(row.path); assert(path.isAbsolute(row.filename) && !owners.has(row.filename)); owners.add(row.filename); }
    for (const owner of receipt.originalOwners) assert.equal(owner.filename, rows.find(row => row.path === owner.path)?.filename, 'Consumer owner receipt changed');
    return { input, receipt, outputRoot };
}
export async function verifyDescriptorSubstitutor({ outputRoot, expectedReceiptSha256 }) {
    const result = await replay(outputRoot, expectedReceiptSha256), rows = await inventory(result.receipt.selectedInventory);
    await checkRelevant(result.input, result.receipt.bindings, result.receipt.originalOwners, rows, result.receipt.recordedPropertyImports);
    for (const pin of result.receipt.files) verifyFile(await readRegular(path.join(result.outputRoot, pin.path)), pin);
    return result.receipt;
}
export async function verifyFinalDescriptorSubstitutor({ outputRoot, expectedReceiptSha256, retainedSources, recordedPropertyImports = [] }) {
    const { input, receipt, outputRoot: root } = await replay(outputRoot, expectedReceiptSha256), rows = await inventory(retainedSources), checked = [];
    await checkRelevant(input, receipt.bindings, receipt.originalOwners, rows, recordedPropertyImports);
    assert(!rows.some(row => input.lock.implementations.includes(row.path)), 'Original Java substitution source reintroduced');
    for (const pin of receipt.files) {
        const row = rows.find(row => row.path === pin.path); assert(row, 'Missing substitution output');
        assert.equal(row.filename, path.join(root, pin.path), 'Wrong substitution output owner');
        const canonical = input.common.get(path.basename(pin.path)), bytes = await readRegular(row.filename);
        assert(bytes.equals(canonical) || bytes.equals(assembleImports(canonical, recordedPropertyImports)), 'Substitution output body/imports changed'); checked.push(row);
    }
    assert.equal(rows.filter(row => row.path.startsWith(OUTPUT_PREFIX)).length, names.length, 'Unrecorded substitution output');
    return { receipt: { schemaVersion: 1, kind: 'genuine-descriptor-substitution-final', sourceLockSha256: sha256(input.lockBytes), checked,
        selectedSources: rows.length, removedFromPredecessorView: receipt.files.map(pin => pin.path), exactBodyAndOwnerVerified: true,
        fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false },
        predecessorRetainedSources: retainedSources.filter(row => !row.path.startsWith(OUTPUT_PREFIX)) };
}
