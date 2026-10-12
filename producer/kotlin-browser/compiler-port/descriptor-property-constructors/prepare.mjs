import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { assembleImports } from '../type-substitutor-getter/prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export const OUTPUT_PREFIX = 'compiler-port-descriptor-property-constructors/';
const names = ['VariableDescriptorWithInitializerImpl.kt', 'PropertyAccessorDescriptorImpl.kt', 'PropertyGetterDescriptorImpl.kt',
    'PropertySetterDescriptorImpl.kt', 'PropertyDescriptorImpl.kt', 'ClassConstructorDescriptorImpl.kt'];
const rootCheck = root => assert(path.isAbsolute(root) && root.startsWith(path.join(REPO, 'out') + path.sep), 'Property constructor output must be under out/');
async function load(sourceRoot) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'genuine-descriptor-property-constructor-family');
    assert.equal(lock.primaryClosureSha256, sha256(closureBytes)); assert.deepEqual(lock.source, closure.source);
    assert.deepEqual(lock.common.map(pin => pin.path), names);
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    const originals = new Map(), common = new Map(), contracts = new Map();
    for (const pin of lock.originals) {
        assert.deepEqual(pin, closure.files.find(row => row.path === pin.path));
        originals.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin));
    }
    for (const pin of lock.common) common.set(pin.path, verifyFile(await readRegular(path.join(HERE, pin.path)), pin));
    for (const binding of lock.bindings) for (const pin of binding.files) verifyFile(await readRegular(path.join(HERE, pin.localPath)), pin);
    for (const contract of lock.contracts) {
        const before = verifyFile(await readRegular(path.join(HERE, contract.input.localPath)), contract.input);
        const after = verifyFile(await readRegular(path.join(HERE, contract.output.localPath)), contract.output);
        assert.equal(before.toString().split(contract.before).length, 2);
        assert.equal(after.toString().split(contract.after).length, 2);
        assert.equal(after.toString().replace(contract.after, contract.before), before.toString(), 'Only the pinned nullable return span may change');
        contracts.set(contract.path, { before, after });
    }
    return { lock, lockBytes, originals, common, contracts };
}
async function inventory(rows) {
    assert(Array.isArray(rows) && rows.length, 'Actual property constructor selection required');
    const paths = new Set(), filenames = new Set(), result = [];
    for (const row of rows) {
        relativePath(row.path); assert(!paths.has(row.path), 'Duplicate property constructor logical path'); paths.add(row.path);
        assert(path.isAbsolute(row.filename) && !filenames.has(row.filename), 'Duplicate property constructor owner'); filenames.add(row.filename);
        const bytes = await readRegular(row.filename);
        assert.equal(bytes.length, row.bytes, 'Property constructor selection bytes changed'); assert.equal(sha256(bytes), row.sha256, 'Property constructor selection SHA changed');
        result.push({ path: row.path, filename: row.filename, bytes: row.bytes, sha256: row.sha256 });
    }
    return result;
}
async function relevant(input, bindings, originalOwners, rows, imports, contractsReplaced = false) {
    assert.equal(bindings.length, input.lock.bindings.length);
    for (const [i, binding] of bindings.entries()) {
        const spec = input.lock.bindings[i]; assert.equal(binding.name, spec.name); rootCheck(binding.outputRoot);
        assert.equal(binding.receiptPath, path.join(binding.outputRoot, 'receipt.json'));
        const bytes = await readRegular(binding.receiptPath), receipt = JSON.parse(bytes);
        assert.equal(sha256(bytes), binding.receiptSha256, 'Property constructor predecessor receipt changed');
        assert.equal(receipt.kind, spec.kind); assert.deepEqual(receipt.source, input.lock.source); assert.equal(receipt.sourceLockSha256, spec.sourceLockSha256);
        for (const pin of spec.files) {
            const receiptPin = receipt.files.find(row => row.path === pin.receiptPath);
            assert(receiptPin, 'Missing property constructor predecessor artifact'); assert.equal(receiptPin.bytes, pin.bytes); assert.equal(receiptPin.sha256, pin.sha256);
            const predecessorFilename = path.join(binding.outputRoot, pin.outputPath), canonical = await readRegular(path.join(HERE, pin.localPath));
            const previous = await readRegular(predecessorFilename);
            assert(previous.equals(canonical) || previous.equals(assembleImports(canonical, imports)), 'Property constructor predecessor source body changed');
            const row = rows.find(row => row.path === pin.path); assert(row, 'Missing property constructor predecessor selection');
            if (!(contractsReplaced && input.contracts.has(pin.path))) {
                assert.equal(row.filename, predecessorFilename, 'Wrong property constructor predecessor owner');
                const actual = await readRegular(row.filename);
                assert(actual.equals(canonical) || actual.equals(assembleImports(canonical, imports)), 'Property constructor predecessor body/imports changed');
            }
        }
    }
    assert.deepEqual(originalOwners.map(row => row.path), input.lock.consumers);
    for (const owner of originalOwners) {
        const row = rows.find(row => row.path === owner.path); assert(row, 'Missing genuine property constructor consumer');
        assert.equal(row.filename, owner.filename, 'Wrong genuine property constructor consumer owner');
        const original = input.originals.get(row.path), actual = await readRegular(row.filename);
        assert(actual.equals(original) || actual.equals(assembleImports(original, imports)), 'Genuine property constructor consumer body/imports changed');
    }
}
function receiptFor(input, bindings, originalOwners, selectedInventory, recordedPropertyImports) {
    const files = [...input.lock.common.map(pin => ({ path: OUTPUT_PREFIX + pin.path, bytes: pin.bytes, sha256: pin.sha256, gitBlob: pin.gitBlob })),
        ...input.lock.contracts.map(pin => ({ path: pin.path, bytes: pin.output.bytes, sha256: pin.output.sha256, gitBlob: pin.output.gitBlob }))];
    return { schemaVersion: 1, kind: 'genuine-descriptor-property-constructor-preparation', source: input.lock.source, sourceLockSha256: sha256(input.lockBytes),
        files, replacedOriginalPaths: [...input.lock.implementations, ...input.lock.contracts.map(pin => pin.path)], bindings, originalOwners, selectedInventory, recordedPropertyImports,
        contractPredecessorRows: input.lock.contracts.map(pin => selectedInventory.find(row => row.path === pin.path)),
        preserved: ['complete accessor flags, visitor and delegation', 'complete property copy builder and virtual substitution',
            'nullable out-type projection, setter projection fallback, receivers, overrides and fields', 'constant initializer factory and cache reset',
            'constructor initialization, dispatch/context receivers and copy restrictions'],
        nullableSubstituteContracts: input.lock.contracts.map(pin => pin.path), assertionsEnabled: true,
        rawJavaNullContractParity: false, externalJavaCollectionMutationParity: false,
        fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareDescriptorPropertyConstructors(args) {
    const sourceRoot = path.resolve(args.sourceRoot), outputRoot = path.resolve(args.outputRoot), imports = args.recordedPropertyImports ?? [];
    rootCheck(outputRoot); await assertNoSymlink(outputRoot);
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Property constructor roots overlap');
    const input = await load(sourceRoot), rows = await inventory(args.retainedSources), bindings = [];
    assert(!rows.some(row => input.lock.implementations.includes(row.path) || row.path.startsWith(OUTPUT_PREFIX)), 'Property constructor source already selected');
    for (const spec of input.lock.bindings) {
        const supplied = args[spec.name]; assert(supplied?.outputRoot && supplied.receipt, 'Missing ' + spec.name);
        const root = path.resolve(supplied.outputRoot); rootCheck(root); await assertNoSymlink(root);
        const receiptPath = path.join(root, 'receipt.json'), bytes = await readRegular(receiptPath);
        assert.deepEqual(JSON.parse(bytes), supplied.receipt, 'Supplied property constructor predecessor receipt changed');
        bindings.push({ name: spec.name, outputRoot: root, receiptPath, receiptSha256: sha256(bytes) });
    }
    const originalOwners = input.lock.consumers.map(logical => { const row = rows.find(row => row.path === logical); assert(row); return { path: logical, filename: row.filename }; });
    await relevant(input, bindings, originalOwners, rows, imports);
    const receipt = receiptFor(input, bindings, originalOwners, rows, imports), commonSources = [];
    for (const [logical, bytes] of input.originals) {
        const filename = path.join(outputRoot, 'reference', logical); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { mode: 0o600, flag: 'wx' });
    }
    for (const pin of receipt.files) {
        const bytes = pin.path.startsWith(OUTPUT_PREFIX) ? input.common.get(path.basename(pin.path)) : input.contracts.get(pin.path).after;
        const filename = path.join(outputRoot, pin.path); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { mode: 0o600, flag: 'wx' }); commonSources.push(filename);
    }
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath)), commonSources, replacedOriginalPaths: receipt.replacedOriginalPaths };
}
async function replay(outputRoot, expectedReceiptSha256) {
    outputRoot = path.resolve(outputRoot); rootCheck(outputRoot); await assertNoSymlink(outputRoot);
    const input = await load(path.join(outputRoot, 'reference')), bytes = await readRegular(path.join(outputRoot, 'receipt.json'), 64 * 1024 * 1024), receipt = JSON.parse(bytes);
    assert.equal(sha256(bytes), expectedReceiptSha256, 'Immutable property constructor receipt pin required');
    assert.deepEqual(receipt, receiptFor(input, receipt.bindings, receipt.originalOwners, receipt.selectedInventory, receipt.recordedPropertyImports));
    return { input, receipt, outputRoot };
}
export async function verifyDescriptorPropertyConstructors({ outputRoot, expectedReceiptSha256 }) {
    const result = await replay(outputRoot, expectedReceiptSha256), rows = await inventory(result.receipt.selectedInventory);
    await relevant(result.input, result.receipt.bindings, result.receipt.originalOwners, rows, result.receipt.recordedPropertyImports);
    for (const pin of result.receipt.files) verifyFile(await readRegular(path.join(result.outputRoot, pin.path)), pin);
    return result.receipt;
}
export async function verifyFinalDescriptorPropertyConstructors({ outputRoot, expectedReceiptSha256, retainedSources, recordedPropertyImports = [] }) {
    const { input, receipt, outputRoot: root } = await replay(outputRoot, expectedReceiptSha256), rows = await inventory(retainedSources), checked = [];
    await relevant(input, receipt.bindings, receipt.originalOwners, rows, recordedPropertyImports, true);
    assert(!rows.some(row => input.lock.implementations.includes(row.path)), 'Original Java property constructor source reintroduced');
    for (const pin of receipt.files) {
        const row = rows.find(row => row.path === pin.path); assert(row, 'Missing property constructor output');
        assert.equal(row.filename, path.join(root, pin.path), 'Wrong property constructor output owner');
        const canonical = pin.path.startsWith(OUTPUT_PREFIX) ? input.common.get(path.basename(pin.path)) : input.contracts.get(pin.path).after;
        const bytes = await readRegular(row.filename);
        assert(bytes.equals(canonical) || bytes.equals(assembleImports(canonical, recordedPropertyImports)), 'Property constructor output body/imports changed'); checked.push(row);
    }
    assert.equal(rows.filter(row => row.path.startsWith(OUTPUT_PREFIX)).length, names.length, 'Unrecorded property constructor output');
    const predecessors = new Map();
    for (const row of receipt.contractPredecessorRows) {
        assert(row && input.contracts.has(row.path));
        const bytes = await readRegular(row.filename), canonical = input.contracts.get(row.path).before;
        assert(bytes.equals(canonical) || bytes.equals(assembleImports(canonical, recordedPropertyImports)), 'Property contract predecessor body/imports changed');
        predecessors.set(row.path, { path: row.path, filename: row.filename, bytes: bytes.length, sha256: sha256(bytes) });
    }
    return { receipt: { schemaVersion: 1, kind: 'genuine-descriptor-property-constructor-final', sourceLockSha256: sha256(input.lockBytes), checked,
        selectedSources: rows.length, removedFromPredecessorView: receipt.files.filter(pin => pin.path.startsWith(OUTPUT_PREFIX)).map(pin => pin.path),
        restoredContractPredecessors: [...predecessors.values()], exactBodyAndOwnerVerified: true,
        fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false },
        predecessorRetainedSources: retainedSources.filter(row => !row.path.startsWith(OUTPUT_PREFIX)).map(row => predecessors.get(row.path) ?? row) };
}
