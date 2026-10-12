import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { assembleImports } from '../type-substitutor-getter/prepare.mjs';
import { normalizeImports } from '../descriptor-base-implementations/prepare.mjs';
import { MODULE_AWARE, BRIDGE, CONTRACT_PATHS, CONSUMER_IMPORTS, transformClassContract, reverseClassContract } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export const OUTPUT_PREFIX = 'compiler-port-descriptor-classes/';
const names = ['AbstractClassDescriptor.kt', 'ClassDescriptorBase.kt', 'ClassDescriptorImpl.kt', 'LazySubstitutingClassDescriptor.kt', 'EnumEntrySyntheticClassDescriptor.kt', 'LazyClassReceiverParameterDescriptor.kt', 'AbstractClassTypeConstructor.kt', 'ClassTypeConstructorImpl.kt', 'ClassDescriptorProperties.kt'];
const rootCheck = root => assert(path.isAbsolute(root) && root.startsWith(path.join(REPO, 'out') + path.sep), 'Class descriptor output must be under out/');
function assemblyMatches(actual, canonical, imports) {
    assert(Array.isArray(imports) && new Set(imports).size === imports.length, 'Duplicate class assembly imports');
    const assembled = assembleImports(canonical, imports);
    return actual.equals(assembled) || normalizeImports(actual, imports).equals(normalizeImports(canonical, []));
}
function inputOriginalEquals(a, b) { return b && a.equals(b); }
async function load(sourceRoot) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'genuine-descriptor-class-family');
    assert.equal(lock.primaryClosureSha256, sha256(closureBytes)); assert.deepEqual(lock.source, closure.source);
    assert.deepEqual(lock.common.map(pin => pin.path), names); assert.deepEqual(lock.visibilityBridge, BRIDGE);
    assert.deepEqual(lock.contracts.map(row => row.path), CONTRACT_PATHS);
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
        assert(transformClassContract(contract.path, before).equals(after)); assert(reverseClassContract(contract.path, after).equals(before));
        assert.deepEqual(contract.input.original, closure.files.find(row => row.path === contract.path));
        assert(inputOriginalEquals(before, originals.get(contract.path)), 'Canonical class consumer original changed');
        contracts.set(contract.path, { before, after });
    }
    return { lock, lockBytes, originals, common, contracts };
}
async function inventory(rows) {
    assert(Array.isArray(rows) && rows.length, 'Actual class descriptor selection required');
    const paths = new Set(), filenames = new Set(), result = [];
    for (const row of rows) {
        relativePath(row.path); assert(!paths.has(row.path), 'Duplicate class descriptor logical path'); paths.add(row.path);
        assert(path.isAbsolute(row.filename) && !filenames.has(row.filename), 'Duplicate class descriptor owner'); filenames.add(row.filename);
        const bytes = await readRegular(row.filename);
        assert.equal(bytes.length, row.bytes, 'Class descriptor selection bytes changed'); assert.equal(sha256(bytes), row.sha256, 'Class descriptor selection SHA changed');
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
        assert.equal(sha256(bytes), binding.receiptSha256, 'Class descriptor predecessor receipt changed');
        assert.equal(receipt.kind, spec.kind); assert.deepEqual(receipt.source, input.lock.source); assert.equal(receipt.sourceLockSha256, spec.sourceLockSha256);
        for (const pin of spec.files) {
            const receiptPin = receipt.files.find(row => row.path === pin.receiptPath);
            assert(receiptPin, 'Missing class descriptor predecessor artifact'); assert.equal(receiptPin.bytes, pin.bytes); assert.equal(receiptPin.sha256, pin.sha256);
            const predecessorFilename = path.join(binding.outputRoot, pin.outputPath), canonical = await readRegular(path.join(HERE, pin.localPath));
            const previous = await readRegular(predecessorFilename);
            assert(assemblyMatches(previous, canonical, imports), 'Class descriptor predecessor source body changed');
            const row = rows.find(row => row.path === pin.path); assert(row, 'Missing class descriptor predecessor selection');
            if (!(contractsReplaced && input.contracts.has(pin.path))) {
                assert.equal(row.filename, predecessorFilename, 'Wrong class descriptor predecessor owner');
                const actual = await readRegular(row.filename);
                assert(assemblyMatches(actual, canonical, imports), 'Class descriptor predecessor body/imports changed');
            }
        }
    }
    assert.deepEqual(originalOwners.map(row => row.path), input.lock.consumers);
    for (const owner of originalOwners) {
        if (contractsReplaced && input.contracts.has(owner.path)) continue;
        const row = rows.find(row => row.path === owner.path); assert(row, 'Missing genuine class descriptor consumer');
        assert.equal(row.filename, owner.filename, 'Wrong genuine class descriptor consumer owner');
        const original = input.originals.get(row.path), actual = await readRegular(row.filename);
        assert(assemblyMatches(actual, original, imports), 'Genuine class descriptor consumer body/imports changed');
    }
}
function receiptFor(input, bindings, originalOwners, selectedInventory, recordedPropertyImports) {
    const files = [...input.lock.common.map(pin => ({ path: OUTPUT_PREFIX + pin.path, bytes: pin.bytes, sha256: pin.sha256, gitBlob: pin.gitBlob })),
        ...input.lock.contracts.map(pin => ({ path: pin.path, bytes: pin.output.bytes, sha256: pin.output.sha256, gitBlob: pin.output.gitBlob }))];
    return { schemaVersion: 1, kind: 'genuine-descriptor-class-preparation', source: input.lock.source, sourceLockSha256: sha256(input.lockBytes),
        files, replacedOriginalPaths: [...input.lock.implementations, ...input.lock.contracts.map(pin => pin.path)], bindings, originalOwners, selectedInventory, recordedPropertyImports,
        contractPredecessorRows: input.lock.contracts.map(pin => selectedInventory.find(row => row.path === pin.path)),
        preserved: ['complete class lazy default type and refinement callback', 'exact protected scope overload dispatch',
            'class receivers and constructor/substitution/member-scope delegation', 'class type constructors and supertype graph neighbours',
            'enum fake override computation, caches, original filter handling and name sets'],
        visibilityBridge: input.lock.visibilityBridge, localConsumerImports: CONSUMER_IMPORTS, annotatedNonnullContractsUnchanged: true, assertionsEnabled: true,
        commonOverridingUtilClosureOpen: true, commonDescriptorUtilsClosureOpen: true,
        rawJavaNullContractParity: false, externalJavaCollectionMutationParity: false,
        fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareDescriptorClassImplementations(args) {
    const sourceRoot = path.resolve(args.sourceRoot), outputRoot = path.resolve(args.outputRoot), imports = args.recordedPropertyImports ?? [];
    rootCheck(outputRoot); await assertNoSymlink(outputRoot);
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Class descriptor roots overlap');
    const input = await load(sourceRoot), rows = await inventory(args.retainedSources), bindings = [];
    assert(!rows.some(row => input.lock.implementations.includes(row.path) || row.path.startsWith(OUTPUT_PREFIX)), 'Class descriptor source already selected');
    for (const spec of input.lock.bindings) {
        const supplied = args[spec.name]; assert(supplied?.outputRoot && supplied.receipt, 'Missing ' + spec.name);
        const root = path.resolve(supplied.outputRoot); rootCheck(root); await assertNoSymlink(root);
        const receiptPath = path.join(root, 'receipt.json'), bytes = await readRegular(receiptPath);
        assert.deepEqual(JSON.parse(bytes), supplied.receipt, 'Supplied class descriptor predecessor receipt changed');
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
    return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath)), commonSources, replacedOriginalPaths: receipt.replacedOriginalPaths, predecessorBindings: [] };
}
async function replay(outputRoot, expectedReceiptSha256) {
    outputRoot = path.resolve(outputRoot); rootCheck(outputRoot); await assertNoSymlink(outputRoot);
    const input = await load(path.join(outputRoot, 'reference')), bytes = await readRegular(path.join(outputRoot, 'receipt.json'), 64 * 1024 * 1024), receipt = JSON.parse(bytes);
    assert.equal(sha256(bytes), expectedReceiptSha256, 'Immutable class descriptor receipt pin required');
    assert.deepEqual(receipt, receiptFor(input, receipt.bindings, receipt.originalOwners, receipt.selectedInventory, receipt.recordedPropertyImports));
    return { input, receipt, outputRoot };
}
export async function verifyDescriptorClassImplementations({ outputRoot, expectedReceiptSha256 }) {
    const result = await replay(outputRoot, expectedReceiptSha256), rows = await inventory(result.receipt.selectedInventory);
    await relevant(result.input, result.receipt.bindings, result.receipt.originalOwners, rows, result.receipt.recordedPropertyImports);
    for (const pin of result.receipt.files) verifyFile(await readRegular(path.join(result.outputRoot, pin.path)), pin);
    return result.receipt;
}
export async function verifyFinalDescriptorClassImplementations({ outputRoot, expectedReceiptSha256, retainedSources, recordedPropertyImports = [] }) {
    const { input, receipt, outputRoot: root } = await replay(outputRoot, expectedReceiptSha256), rows = await inventory(retainedSources), checked = [];
    await relevant(input, receipt.bindings, receipt.originalOwners, rows, recordedPropertyImports, true);
    assert(!rows.some(row => input.lock.implementations.includes(row.path)), 'Original Java class descriptor source reintroduced');
    for (const pin of receipt.files) {
        const row = rows.find(row => row.path === pin.path); assert(row, 'Missing class descriptor output');
        assert.equal(row.filename, path.join(root, pin.path), 'Wrong class descriptor output owner');
        const canonical = pin.path.startsWith(OUTPUT_PREFIX) ? input.common.get(path.basename(pin.path)) : input.contracts.get(pin.path).after;
        const bytes = await readRegular(row.filename);
        assert(assemblyMatches(bytes, canonical, recordedPropertyImports), 'Class descriptor output body/imports changed'); checked.push(row);
    }
    assert.equal(rows.filter(row => row.path.startsWith(OUTPUT_PREFIX)).length, names.length, 'Unrecorded class descriptor output');
    const predecessors = new Map();
    for (const row of receipt.contractPredecessorRows) {
        assert(row && input.contracts.has(row.path));
        const bytes = await readRegular(row.filename), canonical = input.contracts.get(row.path).before;
        assert(assemblyMatches(bytes, canonical, recordedPropertyImports), 'Property contract predecessor body/imports changed');
        predecessors.set(row.path, { path: row.path, filename: row.filename, bytes: bytes.length, sha256: sha256(bytes) });
    }
    return { receipt: { schemaVersion: 1, kind: 'genuine-descriptor-class-final', sourceLockSha256: sha256(input.lockBytes), checked,
        selectedSources: rows.length, removedFromPredecessorView: receipt.files.filter(pin => pin.path.startsWith(OUTPUT_PREFIX)).map(pin => pin.path),
        restoredContractPredecessors: [...predecessors.values()], exactBodyAndOwnerVerified: true,
        fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false },
        predecessorRetainedSources: retainedSources.filter(row => !row.path.startsWith(OUTPUT_PREFIX)).map(row => predecessors.get(row.path) ?? row) };
}
