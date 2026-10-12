import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { assembleImports } from '../type-substitutor-getter/prepare.mjs';
import { normalizeImports } from '../descriptor-base-implementations/prepare.mjs';
import { TARGET, CLASS_CONSTRUCTOR, CHANGES, applyBindings } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export const OUTPUT_PREFIX = 'compiler-port-descriptor-typealias-constructors/';
const NAME = 'TypeAliasConstructorBindings.kt';
function checkRoot(root) { assert(path.isAbsolute(root) && root.startsWith(path.join(REPO, 'out') + path.sep), 'Typealias output must be under out/'); }
function assembledEquals(actual, canonical, imports) { return actual.equals(assembleImports(canonical, imports)) || normalizeImports(actual, imports).equals(normalizeImports(canonical, [])); }
async function load(sourceRoot) {
    const bytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(bytes), closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'genuine-typealias-constructor-bindings'); assert.deepEqual(lock.source, closure.source); assert.equal(lock.primaryClosureSha256, sha256(closureBytes));
    assert.equal(lock.target, TARGET); assert.equal(lock.classConstructor, CLASS_CONSTRUCTOR); assert.deepEqual(lock.changes, CHANGES); assert.equal(lock.common.path, NAME);
    assert(Array.isArray(lock.assemblyImports) && new Set(lock.assemblyImports).size === lock.assemblyImports.length);
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    for (const pin of lock.originals) { assert.deepEqual(pin, closure.files.find(row => row.path === pin.path)); verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin); }
    const common = verifyFile(await readRegular(path.join(HERE, NAME)), lock.common), before = verifyFile(await readRegular(path.join(HERE, lock.contract.input.localPath)), lock.contract.input), after = verifyFile(await readRegular(path.join(HERE, lock.contract.output.localPath)), lock.contract.output);
    assert(applyBindings(before).equals(after)); assert(applyBindings(after, true).equals(before));
    for (const binding of lock.bindings) for (const pin of binding.files) verifyFile(await readRegular(path.join(HERE, pin.localPath)), pin);
    for (const pin of lock.selectionDependencies) verifyFile(await readRegular(path.join(HERE, pin.localPath)), pin);
    return { lock, lockBytes: bytes, common, before, after };
}
async function inventory(rows) {
    assert(Array.isArray(rows) && rows.length, 'Actual typealias selection required'); const paths = new Set(), owners = new Set(), result = [];
    for (const row of rows) { relativePath(row.path); assert.equal(row.compile, true, 'Typealias selection must contain active rows'); assert(!paths.has(row.path), 'Duplicate typealias logical path'); paths.add(row.path);
        assert(path.isAbsolute(row.filename) && !owners.has(row.filename), 'Duplicate typealias owner'); owners.add(row.filename); const b = await readRegular(row.filename);
        assert.equal(b.length, row.bytes, 'Typealias selected bytes changed'); assert.equal(sha256(b), row.sha256, 'Typealias selected SHA changed'); result.push({ path: row.path, filename: row.filename, bytes: row.bytes, sha256: row.sha256 }); }
    return result;
}
async function relevant(input, receipt, rows, imports, replaced = false) {
    assert.equal(receipt.bindings.length, input.lock.bindings.length);
    for (const [i, bound] of receipt.bindings.entries()) { const spec = input.lock.bindings[i]; assert.equal(bound.name, spec.name); checkRoot(bound.outputRoot); assert.equal(bound.receiptPath, path.join(bound.outputRoot, 'receipt.json'));
        const b = await readRegular(bound.receiptPath), parent = JSON.parse(b); assert.equal(sha256(b), bound.receiptSha256, 'Typealias parent receipt changed'); assert.equal(parent.kind, spec.kind); assert.deepEqual(parent.source, input.lock.source); assert.equal(parent.sourceLockSha256, spec.sourceLockSha256);
        for (const pin of spec.files) { const reported = parent.files.find(row => row.path === pin.receiptPath); assert(reported, 'Missing typealias parent artifact'); assert.equal(reported.bytes, pin.bytes); assert.equal(reported.sha256, pin.sha256);
            const filename = path.join(bound.outputRoot, pin.outputPath), original = await readRegular(path.join(HERE, pin.localPath));
            assert(assembledEquals(await readRegular(filename), original, imports), 'Typealias parent body/imports changed');
            if (replaced && pin.path === TARGET) { assert.equal(receipt.contractPredecessorRows[0].filename, filename, 'Wrong typealias signature predecessor owner'); continue; }
            const row = rows.find(row => row.path === pin.path); assert(row, 'Missing typealias parent selection'); assert.equal(row.filename, filename, 'Wrong typealias parent owner'); }
    }
    assert.deepEqual(receipt.selectionOwners.map(row => row.path), input.lock.selectionDependencies.map(row => row.path));
    for (const [i, owner] of receipt.selectionOwners.entries()) { const row = rows.find(row => row.path === owner.path); assert(row, 'Missing typealias selected dependency'); assert.equal(row.filename, owner.filename, 'Wrong typealias selected dependency owner');
        assert(assembledEquals(await readRegular(row.filename), await readRegular(path.join(HERE, input.lock.selectionDependencies[i].localPath)), imports), 'Typealias selected dependency body/imports changed'); }
}
function receiptFor(input, bindings, selectionOwners, selectedInventory, recordedPropertyImports, contractPredecessorRows) {
    assert.equal(contractPredecessorRows.length, 1); const previous = contractPredecessorRows[0]; assert.equal(previous.path, TARGET); assert.equal(previous.compile, true);
    assert.deepEqual({ path: previous.path, filename: previous.filename, bytes: previous.bytes, sha256: previous.sha256 }, selectedInventory.find(row => row.path === TARGET));
    return { schemaVersion: 1, kind: 'genuine-typealias-constructor-binding-preparation', source: input.lock.source, sourceLockSha256: sha256(input.lockBytes),
        files: [{ ...input.lock.common, path: OUTPUT_PREFIX + NAME }, { path: TARGET, bytes: input.lock.contract.output.bytes, sha256: input.lock.contract.output.sha256, gitBlob: input.lock.contract.output.gitBlob }],
        bindings, selectionOwners, selectedInventory, recordedPropertyImports, expectedFinalPropertyImports: input.lock.assemblyImports, contractPredecessorRows, replacedOriginalPaths: [TARGET],
        completeSignaturePredecessorPreserved: true, ownKotlinClassConstructorContractBound: true, virtualActualSetterAndCovariantOriginalPreserved: true,
        sameErasedReceiverListReturned: true, nullableReceiverElementsPreserved: true, receiverElementReadsChecksCopiesAdded: false,
        nonnullReceiverContainerCheck: true, reachableContainersMappedOrEmpty: true, sharedDescriptorContractsChanged: false,
        rawInvalidJavaNullContainerParity: false, fullCommonConsumerWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareDescriptorTypeAliasConstructorBindings(args) {
    const sourceRoot = path.resolve(args.sourceRoot), outputRoot = path.resolve(args.outputRoot), imports = args.recordedPropertyImports ?? []; checkRoot(outputRoot); await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep));
    const input = await load(sourceRoot), rows = await inventory(args.retainedSources), bindings = [];
    assert(!rows.some(row => row.path.startsWith(OUTPUT_PREFIX)), 'Typealias binding source already selected'); assert(imports.length === 0 || JSON.stringify(imports) === JSON.stringify(input.lock.assemblyImports), 'Typealias preparation imports must match locked assembly');
    for (const spec of input.lock.bindings) { const supplied = args[spec.name]; assert(supplied?.outputRoot && supplied.receipt, 'Missing ' + spec.name); const root = path.resolve(supplied.outputRoot); checkRoot(root);
        const receiptPath = path.join(root, 'receipt.json'), b = await readRegular(receiptPath); assert.deepEqual(JSON.parse(b), supplied.receipt, 'Supplied typealias parent receipt changed'); bindings.push({ name: spec.name, outputRoot: root, receiptPath, receiptSha256: sha256(b) }); }
    const owners = input.lock.selectionDependencies.map(pin => { const row = rows.find(row => row.path === pin.path); assert(row, 'Missing typealias selected dependency'); return { path: pin.path, filename: row.filename }; });
    const previous = args.retainedSources.find(row => row.path === TARGET); assert(previous, 'Missing typealias signature consumer');
    const receipt = receiptFor(input, bindings, owners, rows, imports, [{ ...previous }]); await relevant(input, receipt, rows, imports);
    for (const pin of input.lock.originals) { const f = path.join(outputRoot, 'reference', pin.path); await assertNoSymlink(f); await mkdir(path.dirname(f), { recursive: true, mode: 0o700 }); await writeFile(f, await readRegular(path.join(sourceRoot, pin.path)), { flag: 'wx', mode: 0o600 }); }
    const commonSources = [];
    for (const pin of receipt.files) { const f = path.join(outputRoot, pin.path); await assertNoSymlink(f); await mkdir(path.dirname(f), { recursive: true, mode: 0o700 }); await writeFile(f, pin.path === TARGET ? input.after : input.common, { flag: 'wx', mode: 0o600 }); commonSources.push(f); }
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath)), commonSources, replacedOriginalPaths: [TARGET],
        predecessorBindings: [{ component: 'descriptorPlatformSignaturesReceipt', componentRelativePath: TARGET, filename: previous.filename, bytes: previous.bytes, sha256: previous.sha256 }] };
}
async function replay(outputRoot, expectedReceiptSha256) {
    outputRoot = path.resolve(outputRoot); checkRoot(outputRoot); await assertNoSymlink(outputRoot); const input = await load(path.join(outputRoot, 'reference')), b = await readRegular(path.join(outputRoot, 'receipt.json'), 64 * 1024 * 1024), receipt = JSON.parse(b);
    assert.equal(sha256(b), expectedReceiptSha256, 'Immutable typealias receipt pin required'); assert.deepEqual(receipt, receiptFor(input, receipt.bindings, receipt.selectionOwners, receipt.selectedInventory, receipt.recordedPropertyImports, receipt.contractPredecessorRows)); return { input, receipt, outputRoot };
}
export async function verifyDescriptorTypeAliasConstructorBindings(options) {
    const { input, receipt, outputRoot } = await replay(options.outputRoot, options.expectedReceiptSha256), rows = await inventory(receipt.selectedInventory.map(row => ({ ...row, compile: true })));
    await relevant(input, receipt, rows, receipt.recordedPropertyImports); for (const pin of receipt.files) verifyFile(await readRegular(path.join(outputRoot, pin.path)), pin); return receipt;
}
export async function verifyFinalDescriptorTypeAliasConstructorBindings({ outputRoot, expectedReceiptSha256, retainedSources, recordedPropertyImports = [] }) {
    const { input, receipt, outputRoot: root } = await replay(outputRoot, expectedReceiptSha256), rows = await inventory(retainedSources); assert.deepEqual(recordedPropertyImports, input.lock.assemblyImports, 'Typealias final imports must match locked assembly');
    await relevant(input, receipt, rows, recordedPropertyImports, true); const checked = [];
    for (const pin of receipt.files) { const row = rows.find(row => row.path === pin.path); assert(row, 'Missing typealias output'); assert.equal(row.filename, path.join(root, pin.path), 'Wrong typealias output owner');
        assert(assembledEquals(await readRegular(row.filename), pin.path === TARGET ? input.after : input.common, recordedPropertyImports), 'Typealias output body/imports changed'); checked.push(row); }
    assert.equal(rows.filter(row => row.path.startsWith(OUTPUT_PREFIX)).length, 1, 'Unrecorded typealias binding output');
    const previous = receipt.contractPredecessorRows[0], incoming = retainedSources.find(row => row.path === TARGET), bytes = await readRegular(previous.filename);
    assert(assembledEquals(bytes, input.before, recordedPropertyImports), 'Typealias signature predecessor body/imports changed');
    for (const key of Object.keys(previous).filter(key => !['filename', 'bytes', 'sha256'].includes(key))) assert.deepEqual(incoming[key], previous[key], 'Typealias predecessor metadata changed: ' + key);
    const restored = { ...previous, ...incoming, path: TARGET, filename: previous.filename, bytes: bytes.length, sha256: sha256(bytes) };
    return { receipt: { schemaVersion: 1, kind: 'genuine-typealias-constructor-binding-final', sourceLockSha256: sha256(input.lockBytes), checked, selectedSources: rows.length, removedFromPredecessorView: [OUTPUT_PREFIX + NAME],
        restoredContractPredecessors: [restored], exactOwnerBodyAndMetadataVerified: true, fullCommonConsumerWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false },
        predecessorRetainedSources: retainedSources.filter(row => !row.path.startsWith(OUTPUT_PREFIX)).map(row => row.path === TARGET ? restored : row) };
}
