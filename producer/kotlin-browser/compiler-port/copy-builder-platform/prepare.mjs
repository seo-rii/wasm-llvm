import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { verifyDescriptorPlatformSignatures } from '../descriptor-platform-signatures/prepare.mjs';
import { applyBuilderRecipes, guardBuilderSelection, algorithm } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), LIMIT = 160 * 1024 * 1024;
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const pin = (logical, bytes) => ({ path: logical, bytes: bytes.length, sha256: sha256(bytes) });
function checked(bytes, expected) { assert.equal(bytes.length, expected.bytes); assert.equal(sha256(bytes), expected.sha256); return bytes; }
async function load() {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const primaryBytes = await readRegular(path.join(HERE, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
    assert.equal(lock.kind, 'selected-copy-builder-platform-bounds'); assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.primaryClosureSha256, sha256(primaryBytes)); assert.deepEqual(lock.source, primary.source);
    for (const original of lock.originals) assert.deepEqual(original, primary.files.find(item => item.path === original.path));
    for (const dependency of lock.dependencies) checked(await readRegular(path.join(HERE, dependency.path)), dependency);
    const previous = JSON.parse(await readRegular(path.join(HERE, '../descriptor-platform-signatures/sources.lock.json')));
    assert.equal(sha256(await readRegular(path.join(HERE, '../descriptor-platform-signatures/sources.lock.json'))), lock.predecessorLockSha256);
    assert.deepEqual(lock.inputs.filter(item => !item.path.endsWith('/PropertyDescriptor.kt')),
        previous.outputs.filter(item => lock.outputs.some(output => output.path === item.path)));
    assert.equal(lock.inputs.length, 4); assert.equal(lock.outputs.length, 4); assert.equal(lock.recipes.length, 6);
    return { lock, lockBytes, previous };
}
function propertyBinding(supplied, input) {
    const descriptor = supplied.receipts.descriptors.files.find(item => item.path === 'PropertyDescriptor.kt'); assert(descriptor);
    assert.equal(descriptor.absolutePath, path.join(supplied.roots.descriptors, 'generated/PropertyDescriptor.kt'));
    const original = input.lock.inputs.find(item => item.path.endsWith('/PropertyDescriptor.kt'));
    assert.equal(original.bytes, descriptor.bytes); assert.equal(original.sha256, descriptor.sha256);
    return { component: 'descriptorReceipt', componentRelativePath: original.path, filename: descriptor.absolutePath,
        bytes: original.bytes, sha256: original.sha256 };
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
function outputs(input, canonical) {
    return new Map(input.lock.inputs.map(original => {
        const bytes = checked(canonical.get(original.path), original);
        const output = applyBuilderRecipes(bytes, input.lock.recipes.filter(item => item.path === original.path));
        checked(output, input.lock.outputs.find(item => item.path === original.path)); return [original.path, output];
    }));
}
function receiptFor(input, predecessor, snapshotPin, guard, preparedGuard) {
    return { schemaVersion: 1, kind: 'selected-copy-builder-platform-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), primaryClosureSha256: input.lock.primaryClosureSha256,
        preparationToolSha256: input.lock.dependencies.find(item => item.path === 'prepare.mjs').sha256,
        predecessor, snapshot: snapshotPin, files: input.lock.outputs, recipes: input.lock.recipes, guard, preparedGuard,
        platformDAndWildcardBoundsNullable: true, builderObjectResultNonnull: true, buildResultNullable: true,
        originalBuilderBodiesUnchanged: true, fullDescriptorRuntime: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareCopyBuilderPlatform({ outputRoot, preparedSignatures, retainedSources }) {
    outputRoot = path.resolve(outputRoot); assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep)); await assertNoSymlink(outputRoot);
    const predecessorRoot = path.resolve(preparedSignatures.outputRoot);
    assert(predecessorRoot.startsWith(path.join(REPO, 'out') + path.sep));
    assert(outputRoot !== predecessorRoot && !outputRoot.startsWith(predecessorRoot + path.sep) && !predecessorRoot.startsWith(outputRoot + path.sep));
    const input = await load(), verified = await verifyDescriptorPlatformSignatures(predecessorRoot);
    assert.deepEqual(verified.receipt, preparedSignatures.receipt);
    assert.equal(verified.receipt.sourceLockSha256, input.lock.predecessorLockSha256);
    assert.deepEqual(preparedSignatures.commonSources.map(filename => path.relative(predecessorRoot, filename)).sort(), verified.receipt.files.map(item => item.path).sort());
    const retained = await snapshot(retainedSources), selected = new Map(retained.map(item => [item.path, item])), canonical = new Map();
    for (const output of verified.receipt.files) {
        const actual = selected.get(output.path); assert(actual, 'Missing canonical signature output');
        assert.equal(actual.filename, path.join(predecessorRoot, output.path)); canonical.set(output.path, checked(Buffer.from(actual.source, 'base64'), output));
    }
    const supplied = JSON.parse(await readRegular(path.join(predecessorRoot, 'predecessors.json')));
    const property = propertyBinding(supplied, input), selectedProperty = selected.get(property.componentRelativePath); assert(selectedProperty);
    assert.equal(selectedProperty.filename, property.filename);
    canonical.set(property.componentRelativePath, checked(Buffer.from(selectedProperty.source, 'base64'), property));
    for (const original of input.lock.originals) verifyFile(await readRegular(path.join(predecessorRoot, 'reference', original.path)), original);
    const copiedRoot = path.join(outputRoot, 'predecessor'), copiedPins = [];
    const copy = async logical => { const bytes = await readRegular(path.join(predecessorRoot, logical), LIMIT); await publish(copiedRoot, logical, bytes); copiedPins.push(pin(logical, bytes)); };
    for (const name of ['receipt.json', 'predecessors.json', 'selected-source-snapshot.json.gz']) await copy(name);
    for (const reference of verified.receipt.references) await copy('reference/' + reference.path);
    for (const output of verified.receipt.files) await copy(output.path);
    await publish(copiedRoot, property.componentRelativePath, canonical.get(property.componentRelativePath));
    copiedPins.push(pin(property.componentRelativePath, canonical.get(property.componentRelativePath)));
    const transformed = outputs(input, canonical), guard = guardBuilderSelection(code(retained), input.lock.contracts);
    const preparedGuard = guardBuilderSelection(code(retained).map(item => ({ ...item, source: transformed.get(item.path) ?? item.source })), input.lock.contracts, true);
    const serialized = json(retained); assert(serialized.length <= LIMIT); const packed = gzipSync(serialized, { level: 6 }), snapshotPin = pin('selected-source-snapshot.json.gz', packed);
    await publish(outputRoot, snapshotPin.path, packed);
    const commonSources = []; for (const [logical, bytes] of transformed) commonSources.push(await publish(outputRoot, logical, bytes));
    const predecessorBindings = input.lock.inputs.map(item => item.path === property.componentRelativePath ? property : ({
        component: 'descriptorPlatformSignaturesReceipt', componentRelativePath: item.path,
        filename: path.join(predecessorRoot, item.path), bytes: item.bytes, sha256: item.sha256 }));
    const predecessor = { component: 'descriptorPlatformSignaturesReceipt', outputRoot: predecessorRoot, bindings: predecessorBindings,
        receiptSha256: verified.receiptSha256, copiedPins, copiedRoot: 'predecessor', originalFiles: verified.receipt.files };
    const receipt = receiptFor(input, predecessor, snapshotPin, guard, preparedGuard), receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, commonSources, replacedOriginalPaths: input.lock.outputs.map(item => item.path), predecessorBindings, receipt, receiptPath };
}
async function replay(profileRoot) {
    profileRoot = path.resolve(profileRoot); assert(profileRoot.startsWith(path.join(REPO, 'out') + path.sep)); await assertNoSymlink(profileRoot);
    const input = await load(), receiptBytes = await readRegular(path.join(profileRoot, 'receipt.json')), receipt = JSON.parse(receiptBytes);
    assert.equal(receipt.predecessor.copiedRoot, 'predecessor'); assert.equal(receipt.predecessor.component, 'descriptorPlatformSignaturesReceipt');
    const predecessorRoot = path.resolve(receipt.predecessor.outputRoot); assert(predecessorRoot.startsWith(path.join(REPO, 'out') + path.sep));
    const copiedRoot = path.join(profileRoot, 'predecessor'), previous = await verifyDescriptorPlatformSignatures(copiedRoot);
    assert.equal(previous.receiptSha256, receipt.predecessor.receiptSha256); assert.deepEqual(previous.receipt.files, receipt.predecessor.originalFiles);
    const supplied = JSON.parse(await readRegular(path.join(copiedRoot, 'predecessors.json'))), property = propertyBinding(supplied, input);
    const expectedBindings = input.lock.inputs.map(item => item.path === property.componentRelativePath ? property : ({
        component: 'descriptorPlatformSignaturesReceipt', componentRelativePath: item.path,
        filename: path.join(predecessorRoot, item.path), bytes: item.bytes, sha256: item.sha256 }));
    assert.deepEqual(receipt.predecessor.bindings, expectedBindings);
    const expectedCopies = ['receipt.json', 'predecessors.json', 'selected-source-snapshot.json.gz', ...previous.receipt.references.map(item => 'reference/' + item.path), ...previous.receipt.files.map(item => item.path), property.componentRelativePath];
    assert.deepEqual(receipt.predecessor.copiedPins.map(item => item.path), expectedCopies);
    for (const item of receipt.predecessor.copiedPins) checked(await readRegular(path.join(copiedRoot, item.path), LIMIT), item);
    assert.equal(receipt.snapshot.path, 'selected-source-snapshot.json.gz');
    const packed = checked(await readRegular(path.join(profileRoot, receipt.snapshot.path), LIMIT), receipt.snapshot);
    const retained = JSON.parse(gunzipSync(packed, { maxOutputLength: LIMIT })), canonical = new Map();
    for (const original of input.lock.inputs) {
        canonical.set(original.path, checked(await readRegular(path.join(copiedRoot, original.path)), original));
        const actual = retained.find(item => item.path === original.path); assert(actual);
        assert.equal(actual.filename, expectedBindings.find(item => item.componentRelativePath === original.path).filename); checked(Buffer.from(actual.source, 'base64'), original);
    }
    const transformed = outputs(input, canonical), guard = guardBuilderSelection(code(retained), input.lock.contracts);
    const preparedGuard = guardBuilderSelection(code(retained).map(item => ({ ...item, source: transformed.get(item.path) ?? item.source })), input.lock.contracts, true);
    assert.deepEqual(receipt, receiptFor(input, receipt.predecessor, receipt.snapshot, guard, preparedGuard));
    return { input, receipt, receiptSha256: sha256(receiptBytes), transformed };
}
export async function verifyCopyBuilderPlatform(profileRoot) {
    const result = await replay(profileRoot);
    for (const [logical, bytes] of result.transformed) assert.deepEqual(await readRegular(path.join(profileRoot, logical)), bytes);
    return { receipt: result.receipt, receiptSha256: result.receiptSha256 };
}
export async function verifyFinalCopyBuilderPlatform({ profileRoot, retainedSources, allowedAddedImports = [] }) {
    profileRoot = path.resolve(profileRoot); const result = await replay(profileRoot), retained = await snapshot(retainedSources);
    const guard = guardBuilderSelection(code(retained), result.input.lock.contracts, true), checkedOutputs = [];
    const imports = bytes => [...bytes.toString().matchAll(/^import ([^\r\n]+)\r?\n/gm)].map(item => item[1]);
    const predecessorRetainedSources = [];
    for (const actual of retained) {
        const expected = result.transformed.get(actual.path);
        if (!expected) { predecessorRetainedSources.push({ path: actual.path, filename: actual.filename, bytes: actual.bytes, sha256: actual.sha256 }); continue; }
        assert.equal(actual.filename, path.join(profileRoot, actual.path));
        const bytes = Buffer.from(actual.source, 'base64'); assert.equal(algorithm(bytes), algorithm(expected));
        const required = imports(expected), observed = imports(bytes); assert.equal(new Set(observed).size, observed.length);
        for (const name of required) assert(observed.includes(name));
        for (const name of observed) assert(required.includes(name) || allowedAddedImports.includes(name));
        const original = result.input.lock.inputs.find(item => item.path === actual.path), filename = result.receipt.predecessor.bindings.find(item => item.componentRelativePath === actual.path).filename;
        checked(await readRegular(filename), original);
        predecessorRetainedSources.push({ path: actual.path, filename, bytes: original.bytes, sha256: original.sha256 });
        checkedOutputs.push({ path: actual.path, filename: actual.filename, bytes: actual.bytes, sha256: actual.sha256, predecessorFilename: filename, predecessorSha256: original.sha256 });
    }
    assert.equal(checkedOutputs.length, 4);
    return { receipt: { schemaVersion: 1, kind: 'selected-copy-builder-final-selection', preparationReceiptSha256: result.receiptSha256,
        checked: checkedOutputs, guard, predecessorView: 'Only four fully verified metadata-span outputs rebound to their exact unselected canonical predecessor; every other actual final input retained.',
        fullDescriptorRuntime: false, fullCompilerBuilt: false, languageReadiness: false }, predecessorRetainedSources };
}
