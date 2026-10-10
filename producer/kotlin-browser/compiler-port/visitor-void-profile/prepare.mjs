import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { verifyDescriptorVisitorContracts } from '../descriptor-visitor-contract/prepare.mjs';
import { inspectVoidProfile, mapVisitorVoid } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
async function inputs({ sourceRoot, preparedDescriptors, descriptorVisitorComponent, retainedSources }) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'selected-descriptor-visitor-null-only-Void-profile');
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(sha256(closureBytes), lock.primaryClosureSha256); assert.deepEqual(closure.source, lock.source);
    const priorLockBytes = await readRegular(path.join(HERE, '../descriptor-visitor-contract/sources.lock.json'));
    assert.equal(sha256(priorLockBytes), lock.predecessorLockSha256); const priorLock = JSON.parse(priorLockBytes);
    assert.equal(sha256(await readRegular(path.join(HERE, 'transform.mjs'))), lock.transformSha256);
    for (const pin of lock.dependencies) assert.equal(sha256(await readRegular(path.join(HERE, '..', pin.path))), pin.sha256);
    assert.deepEqual(lock.profile, { specializedSignatures: 17, genericTypeTokens: 34, nullableVisitorsPreserved: 14,
        checkedNonnullVoidEntries: 3, javaDescriptorImplementationFamilyClosed: false, globalJavaVoidMapped: false,
        fullCompilerBuilt: false, languageReadiness: false });
    assert(descriptorVisitorComponent?.receiptPath && descriptorVisitorComponent.receipt && descriptorVisitorComponent.commonSources);
    assert(Array.isArray(retainedSources) && retainedSources.length);
    const previousRoot = path.dirname(descriptorVisitorComponent.receiptPath);
    const priorInputs = retainedSources.map(pin => {
        const original = priorLock.originals.find(item => item.path === pin.path);
        return original ? { path: pin.path, filename: path.join(sourceRoot, pin.path), bytes: original.bytes, sha256: original.sha256 } : pin;
    });
    const previous = await verifyDescriptorVisitorContracts({ sourceRoot, preparedDescriptors, retainedSources: priorInputs, profileRoot: previousRoot });
    assert.deepEqual(previous.receipt, descriptorVisitorComponent.receipt, 'Prior visitor receipt differs from full reconstruction replay');
    assert.deepEqual(descriptorVisitorComponent.commonSources.map(filename => path.relative(previousRoot, filename)).sort(), priorLock.preparedOutputs.map(pin => pin.path).sort());
    const selected = new Map(), actualSources = [], inventory = [];
    for (const pin of retainedSources) {
        assert(!selected.has(pin.path), 'Duplicate selected input');
        const bytes = await readRegular(pin.filename); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
        selected.set(pin.path, { ...pin, source: bytes }); actualSources.push({ path: pin.path, source: bytes });
        inventory.push({ path: pin.path, bytes: pin.bytes, sha256: pin.sha256 });
    }
    // All ten earlier outputs must be the actual canonical selected files, even
    // though only three are replaced by this layer.
    for (const pin of priorLock.preparedOutputs) {
        const current = selected.get(pin.path); assert(current, 'Missing prior selected output');
        assert.equal(current.filename, path.join(previousRoot, pin.path), 'Different prior output filename');
        assert.equal(current.bytes, pin.bytes); assert.equal(current.sha256, pin.sha256);
    }
    const originals = [], common = new Map(), predecessorBindings = [];
    for (const pin of lock.originals) {
        assert.deepEqual(pin, closure.files.find(item => item.path === pin.path));
        const original = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin); originals.push({ pin, source: original });
        const inputPin = lock.inputs.find(item => item.path === pin.path), actual = selected.get(pin.path); assert(actual);
        assert.equal(actual.bytes, inputPin.bytes); assert.equal(actual.sha256, inputPin.sha256);
        if (inputPin.predecessor) predecessorBindings.push({ component: 'descriptorVisitorReceipt', componentRelativePath: pin.path,
            filename: actual.filename, bytes: actual.bytes, sha256: actual.sha256, receiptSha256: previous.receiptSha256 });
        else { assert.equal(actual.filename, path.join(sourceRoot, pin.path)); assert.deepEqual(actual.source, original); }
        const output = mapVisitorVoid(actual.source, lock.recipes.filter(recipe => recipe.path === pin.path));
        const outputPin = lock.outputs.find(item => item.path === pin.path); assert.equal(output.length, outputPin.bytes); assert.equal(sha256(output), outputPin.sha256);
        common.set(pin.path, output);
    }
    assert.equal(originals.length, 6); assert.equal(common.size, 6); assert.equal(predecessorBindings.length, 3);
    const guard = inspectVoidProfile(actualSources, lock.recipes);
    const preparedGuard = inspectVoidProfile(actualSources.map(item => ({ ...item, source: common.get(item.path) ?? item.source })), lock.recipes, true);
    return { lock, lockBytes, originals, common, predecessorBindings, previous, inventory, guard, preparedGuard };
}
function receiptFor(input, toolSha256) {
    return { schemaVersion: 1, kind: 'selected-descriptor-visitor-null-only-Void-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: toolSha256, transformSha256: input.lock.transformSha256,
        originals: input.lock.originals, previousVisitorReceiptSha256: input.previous.receiptSha256,
        reconstruction: 'Exactly thirteen genuine visitor-bearing original inputs rebound to their canonical source root; all other current selected inputs unchanged, including both canonical generated contracts. Complete prior preparation replay before mapping.',
        predecessorBindings: input.predecessorBindings, selectedSourceInventory: input.inventory, files: input.lock.outputs,
        recipes: input.lock.recipes, guard: input.guard, preparedGuard: input.preparedGuard, profile: input.lock.profile,
        originalVoidProtocolsOutsideSelectedVisitorTypesUnchanged: true, generatedInterfacesUnchanged: true,
        javaDescriptorImplementationFamilyClosed: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareVisitorVoidProfile(options) {
    const input = await inputs(options), outputRoot = path.resolve(options.outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    for (const root of [options.sourceRoot, options.preparedDescriptors.outputRoot, path.dirname(options.descriptorVisitorComponent.receiptPath)]) {
        const original = path.resolve(root); assert(outputRoot !== original && !outputRoot.startsWith(original + path.sep) && !original.startsWith(outputRoot + path.sep));
    }
    await assertNoSymlink(outputRoot); await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const commonSources = [];
    for (const [logical, bytes] of input.common) {
        const filename = path.join(outputRoot, logical); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); commonSources.push(filename);
    }
    for (const { pin, source } of input.originals) {
        const filename = path.join(outputRoot, 'reference', pin.path); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, source, { flag: 'wx', mode: 0o600 });
    }
    const receipt = receiptFor(input, sha256(await readRegular(fileURLToPath(import.meta.url))));
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { commonSources, replacedOriginalPaths: [...input.common.keys()], predecessorBindings: input.predecessorBindings, receipt, receiptPath };
}
export async function verifyVisitorVoidProfile(options) {
    const input = await inputs(options), outputRoot = path.resolve(options.outputRoot);
    const receiptBytes = await readRegular(path.join(outputRoot, 'receipt.json')), receipt = JSON.parse(receiptBytes);
    assert.deepEqual(receipt, receiptFor(input, sha256(await readRegular(fileURLToPath(import.meta.url)))));
    for (const [logical, source] of input.common) assert.deepEqual(await readRegular(path.join(outputRoot, logical)), source);
    for (const { pin, source } of input.originals) assert.deepEqual(await readRegular(path.join(outputRoot, 'reference', pin.path)), source);
    return { receipt, receiptSha256: sha256(receiptBytes) };
}
