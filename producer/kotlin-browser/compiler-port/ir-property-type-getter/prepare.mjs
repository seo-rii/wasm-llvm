import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { verifyCopyBuilderPlatform } from '../copy-builder-platform/prepare.mjs';
import { IR, ALIAS, applyIrGetterRecipe, inspectIrGetterSelection, algorithm } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), LIMIT = 160 * 1024 * 1024;
const pin = (logical, bytes) => ({ path: logical, bytes: bytes.length, sha256: sha256(bytes) });
function checked(bytes, expected) { assert.equal(bytes.length, expected.bytes); assert.equal(sha256(bytes), expected.sha256); return bytes; }
async function load() {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const primaryBytes = await readRegular(path.join(HERE, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
    assert.equal(lock.kind, 'ir-property-own-getter'); assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.primaryClosureSha256, sha256(primaryBytes)); assert.deepEqual(lock.source, primary.source);
    for (const original of lock.originals) assert.deepEqual(original, primary.files.find(item => item.path === original.path));
    for (const dependency of lock.dependencies) checked(await readRegular(path.join(HERE, dependency.path)), dependency);
    const previousBytes = await readRegular(path.join(HERE, '../copy-builder-platform/sources.lock.json'));
    assert.equal(sha256(previousBytes), lock.predecessorLockSha256);
    const signatureBytes = await readRegular(path.join(HERE, '../descriptor-platform-signatures/sources.lock.json'));
    assert.equal(sha256(signatureBytes), lock.signatureLockSha256);
    assert.deepEqual(lock.input, JSON.parse(signatureBytes).outputs.find(item => item.path === IR));
    assert.equal(lock.output.path, IR); assert.equal(lock.alias.path, ALIAS);
    return { lock, lockBytes };
}
async function publish(root, logical, bytes) {
    relativePath(logical); const filename = path.join(root, logical); await assertNoSymlink(filename);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename;
}
async function snapshot(retainedSources) {
    assert(Array.isArray(retainedSources) && retainedSources.length && retainedSources.length <= 20000);
    const items = [], seen = new Set(); let total = 0;
    for (const source of retainedSources) {
        relativePath(source.path); assert(source.path.endsWith('.kt') && !seen.has(source.path)); seen.add(source.path);
        assert(path.isAbsolute(source.filename)); const bytes = checked(await readRegular(source.filename), source);
        total += bytes.length; assert(total <= LIMIT);
        items.push({ path: source.path, filename: source.filename, bytes: bytes.length, sha256: sha256(bytes), source: bytes.toString('base64') });
    }
    return items;
}
const code = items => items.map(item => ({ path: item.path, source: checked(Buffer.from(item.source, 'base64'), item) }));
function aliasBinding(supplied, input) {
    const alias = supplied.receipts.descriptors.files.find(item => item.path === 'DescriptorProperties.kt'); assert(alias);
    assert.equal(alias.absolutePath, path.join(supplied.roots.descriptors, 'generated/DescriptorProperties.kt'));
    assert.equal(alias.bytes, input.lock.alias.bytes); assert.equal(alias.sha256, input.lock.alias.sha256);
    return { component: 'descriptorReceipt', componentRelativePath: ALIAS, filename: alias.absolutePath, bytes: alias.bytes, sha256: alias.sha256 };
}
function receiptFor(input, predecessor, snapshotPin, guard, preparedGuard) {
    return { schemaVersion: 1, kind: 'ir-property-own-getter-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), primaryClosureSha256: input.lock.primaryClosureSha256,
        preparationToolSha256: input.lock.dependencies.find(item => item.path === 'prepare.mjs').sha256,
        predecessor, snapshot: snapshotPin, files: [input.lock.output], recipe: input.lock.recipe, guard, preparedGuard,
        ownVirtualGetterCalled: true, nullableBaseAliasUnchanged: true, otherSourceBytesUnchanged: true,
        fullDescriptorRuntime: false, fullDescriptorWasm: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareIrPropertyTypeGetter({ outputRoot, preparedCopyBuilder, retainedSources }) {
    outputRoot = path.resolve(outputRoot); assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep)); await assertNoSymlink(outputRoot);
    const previousRoot = path.resolve(preparedCopyBuilder.outputRoot); assert(previousRoot.startsWith(path.join(REPO, 'out') + path.sep));
    assert(outputRoot !== previousRoot && !outputRoot.startsWith(previousRoot + path.sep) && !previousRoot.startsWith(outputRoot + path.sep));
    const input = await load(), verified = await verifyCopyBuilderPlatform(previousRoot);
    assert.deepEqual(verified.receipt, preparedCopyBuilder.receipt); assert.equal(verified.receipt.sourceLockSha256, input.lock.predecessorLockSha256);
    assert.deepEqual(preparedCopyBuilder.commonSources.map(filename => path.relative(previousRoot, filename)).sort(), verified.receipt.files.map(item => item.path).sort());
    const retained = await snapshot(retainedSources), selected = new Map(retained.map(item => [item.path, item]));
    for (const item of verified.receipt.files) { const actual = selected.get(item.path); assert(actual); assert.equal(actual.filename, path.join(previousRoot, item.path)); checked(Buffer.from(actual.source, 'base64'), item); }
    const signatureRoot = verified.receipt.predecessor.outputRoot;
    assert.deepEqual(input.lock.input, verified.receipt.predecessor.originalFiles.find(item => item.path === IR));
    const original = selected.get(IR); assert(original); assert.equal(original.filename, path.join(signatureRoot, IR));
    const canonical = checked(Buffer.from(original.source, 'base64'), input.lock.input);
    const supplied = JSON.parse(await readRegular(path.join(previousRoot, 'predecessor/predecessors.json'))), alias = aliasBinding(supplied, input);
    const selectedAlias = selected.get(ALIAS); assert(selectedAlias); assert.equal(selectedAlias.filename, alias.filename); checked(Buffer.from(selectedAlias.source, 'base64'), alias);
    const copiedPins = [], copiedRoot = path.join(outputRoot, 'copy-builder');
    const copy = async logical => { const bytes = await readRegular(path.join(previousRoot, logical), LIMIT); await publish(copiedRoot, logical, bytes); copiedPins.push(pin(logical, bytes)); };
    for (const name of ['receipt.json', 'selected-source-snapshot.json.gz', ...verified.receipt.files.map(item => item.path), ...verified.receipt.predecessor.copiedPins.map(item => 'predecessor/' + item.path)]) await copy(name);
    await publish(outputRoot, 'alias/DescriptorProperties.kt', Buffer.from(selectedAlias.source, 'base64'));
    for (const item of input.lock.originals) { const bytes = await readRegular(path.join(REPO, 'out/kotlin-compiler-port/sources', item.path)); verifyFile(bytes, item); await publish(outputRoot, 'reference/' + item.path, bytes); }
    const transformed = checked(applyIrGetterRecipe(canonical, input.lock.recipe), input.lock.output);
    const guard = inspectIrGetterSelection(code(retained), input.lock.contracts, input.lock.invariants);
    const preparedGuard = inspectIrGetterSelection(code(retained).map(item => ({ ...item, source: item.path === IR ? transformed : item.source })), input.lock.contracts, input.lock.invariants, true);
    const packed = gzipSync(Buffer.from(JSON.stringify(retained)), { level: 6 }), snapshotPin = pin('selected-source-snapshot.json.gz', packed);
    await publish(outputRoot, snapshotPin.path, packed); const commonSource = await publish(outputRoot, IR, transformed);
    const binding = { component: 'descriptorPlatformSignaturesReceipt', componentRelativePath: IR, filename: original.filename, bytes: original.bytes, sha256: original.sha256 };
    const predecessor = { component: 'copyBuilderPlatformReceipt', outputRoot: previousRoot, copiedRoot: 'copy-builder', copiedPins, receiptSha256: verified.receiptSha256,
        bindings: [binding], alias, signatureRoot };
    const receipt = receiptFor(input, predecessor, snapshotPin, guard, preparedGuard), receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, commonSources: [commonSource], replacedOriginalPaths: [IR], predecessorBindings: [binding], sharedDependencies: [alias], receipt, receiptPath };
}
async function replay(profileRoot) {
    profileRoot = path.resolve(profileRoot); assert(profileRoot.startsWith(path.join(REPO, 'out') + path.sep)); await assertNoSymlink(profileRoot);
    const input = await load(), receiptBytes = await readRegular(path.join(profileRoot, 'receipt.json')), receipt = JSON.parse(receiptBytes);
    assert.equal(receipt.predecessor.component, 'copyBuilderPlatformReceipt'); assert.equal(receipt.predecessor.copiedRoot, 'copy-builder');
    const previousRoot = path.resolve(receipt.predecessor.outputRoot); assert(previousRoot.startsWith(path.join(REPO, 'out') + path.sep));
    const copiedRoot = path.join(profileRoot, 'copy-builder'), previous = await verifyCopyBuilderPlatform(copiedRoot);
    assert.equal(previous.receiptSha256, receipt.predecessor.receiptSha256); assert.equal(previous.receipt.predecessor.outputRoot, receipt.predecessor.signatureRoot);
    assert.deepEqual(input.lock.input, previous.receipt.predecessor.originalFiles.find(item => item.path === IR));
    const expectedCopies = ['receipt.json', 'selected-source-snapshot.json.gz', ...previous.receipt.files.map(item => item.path), ...previous.receipt.predecessor.copiedPins.map(item => 'predecessor/' + item.path)];
    assert.deepEqual(receipt.predecessor.copiedPins.map(item => item.path), expectedCopies);
    for (const item of receipt.predecessor.copiedPins) checked(await readRegular(path.join(copiedRoot, item.path), LIMIT), item);
    const supplied = JSON.parse(await readRegular(path.join(copiedRoot, 'predecessor/predecessors.json'))), alias = aliasBinding(supplied, input);
    assert.deepEqual(receipt.predecessor.alias, alias); checked(await readRegular(path.join(profileRoot, 'alias/DescriptorProperties.kt')), input.lock.alias);
    for (const item of input.lock.originals) verifyFile(await readRegular(path.join(profileRoot, 'reference', item.path)), item);
    assert.equal(receipt.snapshot.path, 'selected-source-snapshot.json.gz');
    const packed = checked(await readRegular(path.join(profileRoot, receipt.snapshot.path), LIMIT), receipt.snapshot), retained = JSON.parse(gunzipSync(packed, { maxOutputLength: LIMIT }));
    const canonical = checked(await readRegular(path.join(copiedRoot, 'predecessor', IR)), input.lock.input);
    const expectedBinding = { component: 'descriptorPlatformSignaturesReceipt', componentRelativePath: IR, filename: path.join(receipt.predecessor.signatureRoot, IR), bytes: input.lock.input.bytes, sha256: input.lock.input.sha256 };
    assert.deepEqual(receipt.predecessor.bindings, [expectedBinding]);
    const selected = new Map(retained.map(item => [item.path, item]));
    for (const item of previous.receipt.files) { const actual = selected.get(item.path); assert(actual); assert.equal(actual.filename, path.join(previousRoot, item.path)); checked(Buffer.from(actual.source, 'base64'), item); }
    const original = selected.get(IR); assert(original); assert.equal(original.filename, expectedBinding.filename); checked(Buffer.from(original.source, 'base64'), input.lock.input);
    const selectedAlias = selected.get(ALIAS); assert(selectedAlias); assert.equal(selectedAlias.filename, alias.filename); checked(Buffer.from(selectedAlias.source, 'base64'), input.lock.alias);
    const transformed = checked(applyIrGetterRecipe(canonical, input.lock.recipe), input.lock.output);
    const guard = inspectIrGetterSelection(code(retained), input.lock.contracts, input.lock.invariants);
    const preparedGuard = inspectIrGetterSelection(code(retained).map(item => ({ ...item, source: item.path === IR ? transformed : item.source })), input.lock.contracts, input.lock.invariants, true);
    assert.deepEqual(receipt, receiptFor(input, receipt.predecessor, receipt.snapshot, guard, preparedGuard));
    return { input, receipt, receiptSha256: sha256(receiptBytes), transformed };
}
export async function verifyIrPropertyTypeGetter(profileRoot) {
    const result = await replay(profileRoot); assert.deepEqual(await readRegular(path.join(profileRoot, IR)), result.transformed);
    return { receipt: result.receipt, receiptSha256: result.receiptSha256 };
}
export async function verifyFinalIrPropertyTypeGetter({ profileRoot, retainedSources, allowedAddedImports = [] }) {
    profileRoot = path.resolve(profileRoot); const result = await replay(profileRoot), retained = await snapshot(retainedSources);
    const guard = inspectIrGetterSelection(code(retained), result.input.lock.contracts, result.input.lock.invariants, true);
    const imports = bytes => [...bytes.toString().matchAll(/^import ([^\r\n]+)\r?\n/gm)].map(item => item[1]);
    const previous = result.receipt.predecessor.bindings[0], checkedOutputs = [], predecessorRetainedSources = [];
    for (const actual of retained) {
        if (![IR, ALIAS].includes(actual.path)) { predecessorRetainedSources.push({ path: actual.path, filename: actual.filename, bytes: actual.bytes, sha256: actual.sha256 }); continue; }
        const expected = actual.path === IR ? result.transformed : await readRegular(path.join(profileRoot, 'alias/DescriptorProperties.kt'));
        assert.equal(actual.filename, actual.path === IR ? path.join(profileRoot, IR) : result.receipt.predecessor.alias.filename);
        const bytes = Buffer.from(actual.source, 'base64'); assert.equal(algorithm(bytes), algorithm(expected));
        const required = imports(expected), observed = imports(bytes); assert.equal(new Set(observed).size, observed.length);
        for (const name of required) assert(observed.includes(name)); for (const name of observed) assert(required.includes(name) || allowedAddedImports.includes(name));
        if (actual.path === IR) { checked(await readRegular(previous.filename), result.input.lock.input);
            predecessorRetainedSources.push({ path: IR, filename: previous.filename, bytes: previous.bytes, sha256: previous.sha256 }); }
        else predecessorRetainedSources.push({ path: actual.path, filename: actual.filename, bytes: actual.bytes, sha256: actual.sha256 });
        checkedOutputs.push({ path: actual.path, filename: actual.filename, bytes: actual.bytes, sha256: actual.sha256 });
    }
    assert.equal(checkedOutputs.length, 2);
    return { receipt: { schemaVersion: 1, kind: 'ir-property-own-getter-final-selection', preparationReceiptSha256: result.receiptSha256,
        checked: checkedOutputs, guard, predecessorView: 'Only the verified single IR output rebound to its exact unselected canonical signature predecessor; every other actual final input retained.',
        fullDescriptorRuntime: false, fullDescriptorWasm: false, fullCompilerBuilt: false, languageReadiness: false }, predecessorRetainedSources };
}
