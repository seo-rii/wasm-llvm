import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { assembleImports } from '../type-substitutor-getter/prepare.mjs';
import { normalizeImports } from '../descriptor-base-implementations/prepare.mjs';
import { SUSPEND_FUNCTIONS, DESERIALIZED_PARAMETER, LOCAL_IMPORTS, transformSuspendFunctions, reverseSuspendFunctions } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export const OUTPUT_PREFIX = 'compiler-port-descriptor-lazy-mutable/';
const NAMES = ['AbstractLazyTypeParameterDescriptor.kt', 'MutableClassDescriptor.kt', 'LazyMutableDescriptorProperties.kt'];
const JAVA = ['AbstractLazyTypeParameterDescriptor', 'MutableClassDescriptor'].map(name => 'core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/' + name + '.java');
const CONSUMERS = [SUSPEND_FUNCTIONS, DESERIALIZED_PARAMETER];
function checkRoot(root) { assert(path.isAbsolute(root) && root.startsWith(path.join(REPO, 'out') + path.sep), 'Lazy/mutable descriptor output must be under out/'); }
function assembledEquals(actual, canonical, imports) {
    assert(Array.isArray(imports) && new Set(imports).size === imports.length, 'Duplicate lazy/mutable assembly imports');
    return actual.equals(assembleImports(canonical, imports)) || normalizeImports(actual, imports).equals(normalizeImports(canonical, []));
}
async function load(sourceRoot) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'genuine-descriptor-lazy-mutable-family');
    assert.equal(lock.primaryClosureSha256, sha256(closureBytes)); assert.deepEqual(lock.source, closure.source);
    assert.deepEqual(lock.implementations, JAVA); assert.deepEqual(lock.consumers, CONSUMERS);
    assert.deepEqual(lock.common.map(pin => pin.path), NAMES); assert.deepEqual(lock.localConsumerImports, LOCAL_IMPORTS);
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    const originals = new Map(), common = new Map();
    for (const pin of lock.originals) {
        assert.deepEqual(pin, closure.files.find(row => row.path === pin.path));
        originals.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin));
    }
    assert.deepEqual([...originals.keys()], [...JAVA, ...CONSUMERS]);
    for (const pin of lock.common) common.set(pin.path, verifyFile(await readRegular(path.join(HERE, pin.path)), pin));
    for (const binding of lock.bindings) for (const pin of binding.files) verifyFile(await readRegular(path.join(HERE, pin.localPath)), pin);
    assert.equal(lock.contract.path, SUSPEND_FUNCTIONS);
    const before = verifyFile(await readRegular(path.join(HERE, lock.contract.input.localPath)), lock.contract.input);
    const after = verifyFile(await readRegular(path.join(HERE, lock.contract.output.localPath)), lock.contract.output);
    assert(before.equals(originals.get(SUSPEND_FUNCTIONS))); assert(transformSuspendFunctions(before).equals(after)); assert(reverseSuspendFunctions(after).equals(before));
    return { lock, lockBytes, originals, common, before, after };
}
async function inventory(rows) {
    assert(Array.isArray(rows) && rows.length, 'Actual lazy/mutable descriptor selection required');
    const paths = new Set(), owners = new Set(), result = [];
    for (const row of rows) {
        relativePath(row.path); assert(!paths.has(row.path), 'Duplicate lazy/mutable logical path'); paths.add(row.path);
        assert(path.isAbsolute(row.filename) && !owners.has(row.filename), 'Duplicate lazy/mutable owner'); owners.add(row.filename);
        const bytes = await readRegular(row.filename);
        assert.equal(bytes.length, row.bytes, 'Lazy/mutable selected bytes changed'); assert.equal(sha256(bytes), row.sha256, 'Lazy/mutable selected SHA changed');
        result.push({ path: row.path, filename: row.filename, bytes: row.bytes, sha256: row.sha256 });
    }
    return result;
}
async function relevant(input, bindings, originalOwners, rows, imports, replaced = false) {
    assert.equal(bindings.length, input.lock.bindings.length);
    for (const [i, binding] of bindings.entries()) {
        const spec = input.lock.bindings[i]; assert.equal(binding.name, spec.name); checkRoot(binding.outputRoot);
        assert.equal(binding.receiptPath, path.join(binding.outputRoot, 'receipt.json'));
        const bytes = await readRegular(binding.receiptPath), receipt = JSON.parse(bytes);
        assert.equal(sha256(bytes), binding.receiptSha256, 'Lazy/mutable predecessor receipt changed');
        assert.equal(receipt.kind, spec.kind); assert.deepEqual(receipt.source, input.lock.source); assert.equal(receipt.sourceLockSha256, spec.sourceLockSha256);
        for (const pin of spec.files) {
            const receiptPin = receipt.files.find(row => row.path === pin.receiptPath); assert(receiptPin, 'Missing lazy/mutable predecessor artifact');
            assert.equal(receiptPin.bytes, pin.bytes); assert.equal(receiptPin.sha256, pin.sha256);
            const filename = path.join(binding.outputRoot, pin.outputPath), canonical = await readRegular(path.join(HERE, pin.localPath));
            const row = rows.find(row => row.path === pin.path); assert(row, 'Missing genuine lazy/mutable predecessor selection');
            assert.equal(row.filename, filename, 'Wrong genuine lazy/mutable predecessor owner');
            assert(assembledEquals(await readRegular(filename), canonical, imports), 'Genuine lazy/mutable predecessor body/imports changed');
        }
    }
    assert.deepEqual(originalOwners.map(row => row.path), CONSUMERS);
    for (const owner of originalOwners) {
        if (replaced && owner.path === SUSPEND_FUNCTIONS) continue;
        const row = rows.find(row => row.path === owner.path); assert(row, 'Missing genuine lazy/mutable consumer');
        assert.equal(row.filename, owner.filename, 'Wrong genuine lazy/mutable consumer owner');
        assert(assembledEquals(await readRegular(row.filename), input.originals.get(row.path), imports), 'Genuine lazy/mutable consumer body/imports changed');
    }
}
function receiptFor(input, bindings, originalOwners, selectedInventory, recordedPropertyImports, contractPredecessorRows) {
    assert.equal(contractPredecessorRows.length, 1);
    const previous = contractPredecessorRows[0], selected = selectedInventory.find(row => row.path === SUSPEND_FUNCTIONS);
    assert.deepEqual(({ path: previous.path, filename: previous.filename, bytes: previous.bytes, sha256: previous.sha256 }), selected);
    return { schemaVersion: 1, kind: 'genuine-descriptor-lazy-mutable-preparation', source: input.lock.source, sourceLockSha256: sha256(input.lockBytes),
        files: [...input.lock.common.map(pin => ({ path: OUTPUT_PREFIX + pin.path, bytes: pin.bytes, sha256: pin.sha256, gitBlob: pin.gitBlob })),
            { path: SUSPEND_FUNCTIONS, bytes: input.lock.contract.output.bytes, sha256: input.lock.contract.output.sha256, gitBlob: input.lock.contract.output.gitBlob }],
        replacedOriginalPaths: [...JAVA, SUSPEND_FUNCTIONS], bindings, originalOwners, selectedInventory, recordedPropertyImports,
        contractPredecessorRows, localConsumerImports: LOCAL_IMPORTS,
        preserved: ['complete lazy type parameter constructor forwarding and lazy virtual toString evaluation',
            'complete mutable class flags, member scopes, one-time parameter copy and live supertype carrier',
            'virtual setter, constructor-return initialization and assertion dispatch'],
        originalFullJavaClasses: JAVA, directGenuineConsumers: CONSUMERS, annotatedNonnullContractsUnchanged: true, assertionsEnabled: true,
        commonOverridingUtilClosureOpen: true, commonDescriptorUtilsClosureOpen: true, rawJavaNullContractParity: false,
        externalJavaCollectionMutationParity: false, fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareDescriptorLazyMutableImplementations(args) {
    const sourceRoot = path.resolve(args.sourceRoot), outputRoot = path.resolve(args.outputRoot), imports = args.recordedPropertyImports ?? [];
    checkRoot(outputRoot); await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Lazy/mutable roots overlap');
    const input = await load(sourceRoot), rows = await inventory(args.retainedSources), bindings = [];
    assert(!rows.some(row => JAVA.includes(row.path) || row.path.startsWith(OUTPUT_PREFIX)), 'Lazy/mutable source already selected');
    for (const spec of input.lock.bindings) {
        const supplied = args[spec.name]; assert(supplied?.outputRoot && supplied.receipt, 'Missing ' + spec.name);
        const root = path.resolve(supplied.outputRoot); checkRoot(root); await assertNoSymlink(root);
        const receiptPath = path.join(root, 'receipt.json'), bytes = await readRegular(receiptPath);
        assert.deepEqual(JSON.parse(bytes), supplied.receipt, 'Supplied lazy/mutable predecessor receipt changed');
        bindings.push({ name: spec.name, outputRoot: root, receiptPath, receiptSha256: sha256(bytes) });
    }
    const originalOwners = CONSUMERS.map(logical => { const row = rows.find(row => row.path === logical); assert(row); return { path: logical, filename: row.filename }; });
    await relevant(input, bindings, originalOwners, rows, imports);
    const predecessors = [args.retainedSources.find(row => row.path === SUSPEND_FUNCTIONS)];
    const receipt = receiptFor(input, bindings, originalOwners, rows, imports, predecessors), commonSources = [];
    for (const [logical, bytes] of input.originals) {
        const filename = path.join(outputRoot, 'reference', logical); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    }
    for (const pin of receipt.files) {
        const bytes = pin.path.startsWith(OUTPUT_PREFIX) ? input.common.get(path.basename(pin.path)) : input.after;
        const filename = path.join(outputRoot, pin.path); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); commonSources.push(filename);
    }
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath)), commonSources, replacedOriginalPaths: receipt.replacedOriginalPaths, predecessorBindings: [] };
}
async function replay(outputRoot, expectedReceiptSha256) {
    outputRoot = path.resolve(outputRoot); checkRoot(outputRoot); await assertNoSymlink(outputRoot);
    const input = await load(path.join(outputRoot, 'reference')), bytes = await readRegular(path.join(outputRoot, 'receipt.json'), 64 * 1024 * 1024), receipt = JSON.parse(bytes);
    assert.equal(sha256(bytes), expectedReceiptSha256, 'Immutable lazy/mutable receipt pin required');
    assert.deepEqual(receipt, receiptFor(input, receipt.bindings, receipt.originalOwners, receipt.selectedInventory, receipt.recordedPropertyImports, receipt.contractPredecessorRows));
    return { input, receipt, outputRoot };
}
export async function verifyDescriptorLazyMutableImplementations({ outputRoot, expectedReceiptSha256 }) {
    const result = await replay(outputRoot, expectedReceiptSha256), rows = await inventory(result.receipt.selectedInventory);
    await relevant(result.input, result.receipt.bindings, result.receipt.originalOwners, rows, result.receipt.recordedPropertyImports);
    for (const pin of result.receipt.files) verifyFile(await readRegular(path.join(result.outputRoot, pin.path)), pin);
    return result.receipt;
}
export async function verifyFinalDescriptorLazyMutableImplementations({ outputRoot, expectedReceiptSha256, retainedSources, recordedPropertyImports = [] }) {
    const { input, receipt, outputRoot: root } = await replay(outputRoot, expectedReceiptSha256), rows = await inventory(retainedSources), checked = [];
    await relevant(input, receipt.bindings, receipt.originalOwners, rows, recordedPropertyImports, true);
    assert(!rows.some(row => JAVA.includes(row.path)), 'Original Java lazy/mutable source reintroduced');
    for (const pin of receipt.files) {
        const row = rows.find(row => row.path === pin.path); assert(row, 'Missing lazy/mutable output');
        assert.equal(row.filename, path.join(root, pin.path), 'Wrong lazy/mutable output owner');
        const canonical = pin.path.startsWith(OUTPUT_PREFIX) ? input.common.get(path.basename(pin.path)) : input.after;
        assert(assembledEquals(await readRegular(row.filename), canonical, recordedPropertyImports), 'Lazy/mutable output body/imports changed'); checked.push(row);
    }
    assert.equal(rows.filter(row => row.path.startsWith(OUTPUT_PREFIX)).length, NAMES.length, 'Unrecorded lazy/mutable output');
    const previous = receipt.contractPredecessorRows[0]; assert(previous?.path === SUSPEND_FUNCTIONS);
    const bytes = await readRegular(previous.filename); assert(assembledEquals(bytes, input.before, recordedPropertyImports), 'Lazy/mutable consumer predecessor body/imports changed');
    const incoming = retainedSources.find(row => row.path === previous.path);
    const predecessor = { ...incoming, ...previous, path: previous.path, filename: previous.filename, bytes: bytes.length, sha256: sha256(bytes) };
    return { receipt: { schemaVersion: 1, kind: 'genuine-descriptor-lazy-mutable-final', sourceLockSha256: sha256(input.lockBytes), checked,
        selectedSources: rows.length, removedFromPredecessorView: receipt.files.filter(pin => pin.path.startsWith(OUTPUT_PREFIX)).map(pin => pin.path),
        restoredContractPredecessors: [predecessor], exactBodyAndOwnerVerified: true,
        fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false },
        predecessorRetainedSources: retainedSources.filter(row => !row.path.startsWith(OUTPUT_PREFIX)).map(row => row.path === SUSPEND_FUNCTIONS ? predecessor : row) };
}
