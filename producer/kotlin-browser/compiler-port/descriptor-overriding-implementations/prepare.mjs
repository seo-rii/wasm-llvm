import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { assembleImports } from '../type-substitutor-getter/prepare.mjs';
import { normalizeImports } from '../descriptor-base-implementations/prepare.mjs';
import { JAVA, OVERLAYS, DIRECT, CONSUMERS, transformConsumer, reverseConsumer } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export const OUTPUT_PREFIX = 'compiler-port-descriptor-overriding/';
const NAMES = ['OverridingUtil.kt', 'OverridingHost.kt', 'OverridingUtilProperties.kt'];
function checkRoot(root) { assert(path.isAbsolute(root) && root.startsWith(path.join(REPO, 'out') + path.sep), 'Overriding output must be under out/'); }
function assembledEquals(actual, canonical, imports) {
    assert(Array.isArray(imports) && new Set(imports).size === imports.length, 'Duplicate overriding assembly imports');
    return actual.equals(assembleImports(canonical, imports)) || normalizeImports(actual, imports).equals(normalizeImports(canonical, []));
}
async function load(sourceRoot) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'genuine-descriptor-overriding-family');
    assert.equal(lock.primaryClosureSha256, sha256(closureBytes)); assert.deepEqual(lock.source, closure.source);
    assert.deepEqual(lock.implementations, [JAVA]); assert.deepEqual(lock.consumers, CONSUMERS); assert.deepEqual(lock.common.map(pin => pin.path), NAMES);
    assert.deepEqual(lock.contracts.map(pin => pin.path), OVERLAYS.map(row => row[0]));
    assert(Array.isArray(lock.assemblyImports) && new Set(lock.assemblyImports).size === lock.assemblyImports.length, 'Invalid locked overriding assembly imports');
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    const originals = new Map(), common = new Map(), overlays = new Map();
    for (const pin of lock.originals) { assert.deepEqual(pin, closure.files.find(row => row.path === pin.path));
        originals.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin)); }
    assert.deepEqual([...originals.keys()], [JAVA, ...CONSUMERS]);
    for (const pin of lock.common) common.set(pin.path, verifyFile(await readRegular(path.join(HERE, pin.path)), pin));
    for (const binding of lock.bindings) for (const pin of binding.files) verifyFile(await readRegular(path.join(HERE, pin.localPath)), pin);
    for (const pin of lock.selectionDependencies) verifyFile(await readRegular(path.join(HERE, pin.localPath)), pin);
    for (const contract of lock.contracts) { const before = verifyFile(await readRegular(path.join(HERE, contract.input.localPath)), contract.input);
        const after = verifyFile(await readRegular(path.join(HERE, contract.output.localPath)), contract.output);
        assert(before.equals(originals.get(contract.path)), 'Canonical overriding consumer changed');
        assert(transformConsumer(contract.path, before).equals(after), 'Complete overriding overlay changed');
        assert(reverseConsumer(contract.path, after).equals(before), 'Overriding overlay is not reversible'); overlays.set(contract.path, after); }
    return { lock, lockBytes, originals, common, overlays };
}
async function inventory(rows) {
    assert(Array.isArray(rows) && rows.length, 'Actual overriding selection required');
    const paths = new Set(), owners = new Set(), result = [];
    for (const row of rows) { relativePath(row.path); assert(!paths.has(row.path), 'Duplicate overriding logical path'); paths.add(row.path);
        assert.equal(row.compile, true, 'Overriding selection must contain active compile rows');
        assert(path.isAbsolute(row.filename) && !owners.has(row.filename), 'Duplicate overriding owner'); owners.add(row.filename);
        const bytes = await readRegular(row.filename); assert.equal(bytes.length, row.bytes, 'Overriding selected bytes changed'); assert.equal(sha256(bytes), row.sha256, 'Overriding selected SHA changed');
        result.push({ path: row.path, filename: row.filename, bytes: row.bytes, sha256: row.sha256 }); }
    return result;
}
async function relevant(input, bindings, originalOwners, selectionOwners, rows, imports, replaced = false) {
    assert.equal(bindings.length, input.lock.bindings.length);
    for (const [i, binding] of bindings.entries()) { const spec = input.lock.bindings[i]; assert.equal(binding.name, spec.name); checkRoot(binding.outputRoot);
        assert.equal(binding.receiptPath, path.join(binding.outputRoot, 'receipt.json'));
        const bytes = await readRegular(binding.receiptPath), receipt = JSON.parse(bytes);
        assert.equal(sha256(bytes), binding.receiptSha256, 'Overriding predecessor receipt changed');
        assert.equal(receipt.kind, spec.kind); assert.deepEqual(receipt.source, input.lock.source); assert.equal(receipt.sourceLockSha256, spec.sourceLockSha256);
        for (const pin of spec.files) { const receiptPin = receipt.files.find(row => row.path === pin.receiptPath); assert(receiptPin, 'Missing overriding predecessor artifact');
            assert.equal(receiptPin.bytes, pin.bytes); assert.equal(receiptPin.sha256, pin.sha256);
            const filename = path.join(binding.outputRoot, pin.outputPath), canonical = await readRegular(path.join(HERE, pin.localPath));
            const row = rows.find(row => row.path === pin.path); assert(row, 'Missing genuine overriding predecessor selection');
            assert.equal(row.filename, filename, 'Wrong genuine overriding predecessor owner');
            assert(assembledEquals(await readRegular(filename), canonical, imports), 'Genuine overriding predecessor body/imports changed'); }
    }
    assert.deepEqual(originalOwners.map(row => row.path), CONSUMERS);
    assert.deepEqual(selectionOwners.map(row => row.path), input.lock.selectionDependencies.map(row => row.path));
    for (const [i, owner] of selectionOwners.entries()) { const row = rows.find(row => row.path === owner.path); assert(row, 'Missing genuine overriding selected dependency');
        assert.equal(row.filename, owner.filename, 'Wrong genuine overriding selected dependency owner');
        assert(assembledEquals(await readRegular(row.filename), await readRegular(path.join(HERE, input.lock.selectionDependencies[i].localPath)), imports), 'Genuine overriding selected dependency body/imports changed'); }
    for (const owner of originalOwners) { if (replaced && OVERLAYS.some(row => row[0] === owner.path)) continue;
        const row = rows.find(row => row.path === owner.path); assert(row, 'Missing genuine overriding consumer');
        assert.equal(row.filename, owner.filename, 'Wrong genuine overriding consumer owner');
        assert(assembledEquals(await readRegular(row.filename), input.originals.get(row.path), imports), 'Genuine overriding consumer body/imports changed'); }
}
function receiptFor(input, bindings, originalOwners, selectionOwners, selectedInventory, recordedPropertyImports, contractPredecessorRows) {
    assert.deepEqual(contractPredecessorRows.map(row => row.path), OVERLAYS.map(row => row[0]));
    for (const previous of contractPredecessorRows) { assert.equal(previous.compile, true);
        assert.deepEqual(({ path: previous.path, filename: previous.filename, bytes: previous.bytes, sha256: previous.sha256 }), selectedInventory.find(row => row.path === previous.path)); }
    return { schemaVersion: 1, kind: 'genuine-descriptor-overriding-preparation', source: input.lock.source, sourceLockSha256: sha256(input.lockBytes),
        files: [...input.lock.common.map(pin => ({ ...pin, path: OUTPUT_PREFIX + pin.path })), ...input.lock.contracts.map(pin => ({ path: pin.path, bytes: pin.output.bytes, sha256: pin.output.sha256, gitBlob: pin.output.gitBlob }))],
        replacedOriginalPaths: [JAVA, ...OVERLAYS.map(row => row[0])], bindings, originalOwners, selectionOwners, selectedInventory, recordedPropertyImports, expectedFinalPropertyImports: input.lock.assemblyImports, contractPredecessorRows,
        completeOriginalJavaClass: JAVA, directGenuineConsumers: [...CONSUMERS, 'compiler-port-descriptor-classes/EnumEntrySyntheticClassDescriptor.kt'],
        completeOriginalMethodsTranslated: true, providerMembershipAndOrderCapturedOnce: true, liveProviderInstancesPreserved: true,
        eagerProviderLoaderRequiredBeforeDefault: true, allVirtualContractReadsAndBothPassesPreserved: true, noEmptyProviderFallback: true,
        providerHostRealmOwnershipEnforced: false, concurrentHostInitializationProven: false, recursiveJavaClassInitializationParity: false,
        portableThreeProvidersImplemented: false, browserProviderInitializationChosen: false, architectureIssue: 'ARCH-010',
        annotatedNonnullContractsUnchanged: true, assertionsEnabled: true, rawJavaNullContractParity: false,
        fullCommonClassWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareDescriptorOverridingImplementations(args) {
    const sourceRoot = path.resolve(args.sourceRoot), outputRoot = path.resolve(args.outputRoot), imports = args.recordedPropertyImports ?? [];
    checkRoot(outputRoot); await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Overriding roots overlap');
    const input = await load(sourceRoot), rows = await inventory(args.retainedSources), bindings = [];
    assert(imports.length === 0 || JSON.stringify(imports) === JSON.stringify(input.lock.assemblyImports), 'Overriding preparation imports must match locked assembly');
    assert(!rows.some(row => row.path === JAVA || row.path.startsWith(OUTPUT_PREFIX)), 'Overriding source already selected');
    for (const spec of input.lock.bindings) { const supplied = args[spec.name]; assert(supplied?.outputRoot && supplied.receipt, 'Missing ' + spec.name);
        const root = path.resolve(supplied.outputRoot); checkRoot(root); await assertNoSymlink(root);
        const receiptPath = path.join(root, 'receipt.json'), bytes = await readRegular(receiptPath); assert.deepEqual(JSON.parse(bytes), supplied.receipt, 'Supplied overriding predecessor receipt changed');
        bindings.push({ name: spec.name, outputRoot: root, receiptPath, receiptSha256: sha256(bytes) }); }
    const originalOwners = CONSUMERS.map(logical => { const row = rows.find(row => row.path === logical); assert(row, 'Missing overriding consumer'); return { path: logical, filename: row.filename }; });
    const selectionOwners = input.lock.selectionDependencies.map(pin => { const row = rows.find(row => row.path === pin.path); assert(row, 'Missing genuine overriding selected dependency'); return { path: pin.path, filename: row.filename }; });
    await relevant(input, bindings, originalOwners, selectionOwners, rows, imports);
    const predecessors = OVERLAYS.map(spec => ({ ...args.retainedSources.find(row => row.path === spec[0]) }));
    const receipt = receiptFor(input, bindings, originalOwners, selectionOwners, rows, imports, predecessors), commonSources = [];
    for (const [logical, bytes] of input.originals) { const filename = path.join(outputRoot, 'reference', logical); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); }
    for (const pin of receipt.files) { const bytes = pin.path.startsWith(OUTPUT_PREFIX) ? input.common.get(path.basename(pin.path)) : input.overlays.get(pin.path);
        const filename = path.join(outputRoot, pin.path); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); commonSources.push(filename); }
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath)), commonSources, replacedOriginalPaths: receipt.replacedOriginalPaths, predecessorBindings: [] };
}
async function replay(outputRoot, expectedReceiptSha256) {
    outputRoot = path.resolve(outputRoot); checkRoot(outputRoot); await assertNoSymlink(outputRoot);
    const input = await load(path.join(outputRoot, 'reference')), bytes = await readRegular(path.join(outputRoot, 'receipt.json'), 64 * 1024 * 1024), receipt = JSON.parse(bytes);
    assert.equal(sha256(bytes), expectedReceiptSha256, 'Immutable overriding receipt pin required');
    assert.deepEqual(receipt, receiptFor(input, receipt.bindings, receipt.originalOwners, receipt.selectionOwners, receipt.selectedInventory, receipt.recordedPropertyImports, receipt.contractPredecessorRows));
    return { input, receipt, outputRoot };
}
export async function verifyDescriptorOverridingImplementations({ outputRoot, expectedReceiptSha256 }) {
    const result = await replay(outputRoot, expectedReceiptSha256), rows = await inventory(result.receipt.selectedInventory.map(row => ({ ...row, compile: true })));
    await relevant(result.input, result.receipt.bindings, result.receipt.originalOwners, result.receipt.selectionOwners, rows, result.receipt.recordedPropertyImports);
    for (const pin of result.receipt.files) verifyFile(await readRegular(path.join(result.outputRoot, pin.path)), pin);
    return result.receipt;
}
export async function verifyFinalDescriptorOverridingImplementations({ outputRoot, expectedReceiptSha256, retainedSources, recordedPropertyImports = [] }) {
    const { input, receipt, outputRoot: root } = await replay(outputRoot, expectedReceiptSha256), rows = await inventory(retainedSources), checked = [];
    assert.deepEqual(recordedPropertyImports, input.lock.assemblyImports, 'Overriding final imports must match locked assembly');
    await relevant(input, receipt.bindings, receipt.originalOwners, receipt.selectionOwners, rows, recordedPropertyImports, true);
    assert(!rows.some(row => row.path === JAVA), 'Original Java overriding source reintroduced');
    for (const pin of receipt.files) { const row = rows.find(row => row.path === pin.path); assert(row, 'Missing overriding output'); assert.equal(row.filename, path.join(root, pin.path), 'Wrong overriding output owner');
        const canonical = pin.path.startsWith(OUTPUT_PREFIX) ? input.common.get(path.basename(pin.path)) : input.overlays.get(pin.path);
        assert(assembledEquals(await readRegular(row.filename), canonical, recordedPropertyImports), 'Overriding output body/imports changed'); checked.push(row); }
    assert.equal(rows.filter(row => row.path.startsWith(OUTPUT_PREFIX)).length, NAMES.length, 'Unrecorded overriding output');
    const restored = new Map();
    for (const previous of receipt.contractPredecessorRows) { const bytes = await readRegular(previous.filename); assert(assembledEquals(bytes, input.originals.get(previous.path), recordedPropertyImports), 'Overriding consumer predecessor body/imports changed');
        const incoming = retainedSources.find(row => row.path === previous.path);
        for (const key of Object.keys(previous).filter(key => !['filename', 'bytes', 'sha256'].includes(key))) assert.deepEqual(incoming[key], previous[key], 'Overriding predecessor metadata changed: ' + key);
        restored.set(previous.path, { ...previous, ...incoming, path: previous.path, filename: previous.filename, bytes: bytes.length, sha256: sha256(bytes) }); }
    const predecessorRetainedSources = retainedSources.filter(row => !row.path.startsWith(OUTPUT_PREFIX)).map(row => restored.get(row.path) ?? row);
    return { receipt: { schemaVersion: 1, kind: 'genuine-descriptor-overriding-final', sourceLockSha256: sha256(input.lockBytes), checked, selectedSources: rows.length,
        removedFromPredecessorView: NAMES.map(name => OUTPUT_PREFIX + name), restoredContractPredecessors: [...restored.values()], exactBodyAndOwnerVerified: true, fullMetadataAndOrderInverse: true,
        portableThreeProvidersImplemented: false, browserProviderInitializationChosen: false, architectureIssue: 'ARCH-010', fullCommonClassWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false }, predecessorRetainedSources };
}
