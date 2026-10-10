import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { verifyDescriptorPreparation } from '../descriptors/prepare.mjs';
import { OUTPUT, encodeVisitorEntries, visitorDeclarations, inspectVisitorConsumers } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');

async function inputs({ sourceRoot, preparedDescriptors, retainedSources }) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'selected-descriptor-visitor-null-dispatch-contract');
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(sha256(closureBytes), lock.primaryClosureSha256); assert.deepEqual(lock.source, closure.source);
    assert.equal(sha256(await readRegular(path.join(HERE, 'transform.mjs'))), lock.transformSha256);
    assert.equal(lock.recipes.length, 12); assert.equal(lock.originals.length, 13); assert.equal(lock.preparedOutputs.length, 10);
    assert.deepEqual(lock.profile, { originalNonnullGenericOverrides: 12, originalNullableOverrides: 29, untouchedNonnullVoidOverrides: 3,
        nullableGeneratedBasePreserved: true, modernJvmCompilerVersion: '2.5.0-dev-10106',
        modernJvmDefaultMode: 'enable (official compiler default)', legacyDefaultImplsMessageParity: false,
        voidMappingClosed: false, fullCompilerBuilt: false, languageReadiness: false });
    const originals = [];
    for (const pin of [...lock.originals, ...lock.javaOriginals, ...lock.probeOriginals]) {
        assert.deepEqual(pin, closure.files.find(item => item.path === pin.path));
        originals.push({ pin, bytes: verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin) });
    }
    const common = new Map();
    for (const pin of lock.originals) {
        const original = originals.find(item => item.pin.path === pin.path).bytes;
        const recipes = lock.recipes.filter(item => item.path === pin.path);
        const output = encodeVisitorEntries(original, recipes);
        const contract = lock.contracts.find(item => item.path === pin.path); assert(contract);
        assert.deepEqual(visitorDeclarations(original).map(row => row.span), contract.declarations);
        assert.deepEqual(visitorDeclarations(output).map(row => row.span), contract.preparedDeclarations);
        if (!recipes.length) { assert.deepEqual(output, original); continue; }
        const outputPin = lock.preparedOutputs.find(item => item.path === pin.path); assert(outputPin);
        assert.equal(output.length, outputPin.bytes); assert.equal(sha256(output), outputPin.sha256);
        // Already-nullable and all Void declarations remain byte-identical.
        const unchanged = visitorDeclarations(original).filter(row => row.nullable || row.method === 'acceptVoid').map(row => row.span);
        const retained = visitorDeclarations(output).filter(row => row.method === 'acceptVoid' || unchanged.includes(row.span)).map(row => row.span);
        assert.deepEqual(retained, unchanged, 'Original nullable/Void visitor body changed');
        common.set(pin.path, output);
    }
    assert.equal(common.size, 10);
    assert(preparedDescriptors?.outputRoot && preparedDescriptors.receipt && preparedDescriptors.sourceFiles);
    const checked = await verifyDescriptorPreparation(preparedDescriptors.outputRoot);
    assert.deepEqual(checked.receipt, preparedDescriptors.receipt, 'Descriptor caller receipt differs from full replay');
    assert.equal(checked.receipt.sourceLockSha256, lock.predecessor.sourceLockSha256);
    assert.equal(checked.receipt.preparationToolSha256, lock.predecessor.preparationToolSha256);
    assert.deepEqual(checked.receipt.tools, lock.predecessor.tools);
    const { absolutePath: filename, ...pin } = checked.receipt.files.find(item => item.path === 'DeclarationDescriptor.kt');
    assert.deepEqual(pin, lock.predecessor.output);
    assert.equal(preparedDescriptors.sourceFiles.filter(file => file === filename).length, 1);
    const visitorFile = checked.receipt.files.find(item => item.path === 'DeclarationDescriptorVisitor.kt');
    const { absolutePath: visitorFilename, ...visitorPin } = visitorFile;
    assert.deepEqual(visitorPin, lock.predecessor.visitorOutput);
    const visitor = await readRegular(visitorFilename);
    assert.equal(visitor.length, visitorPin.bytes); assert.equal(sha256(visitor), visitorPin.sha256);
    assert.equal((visitor.toString().match(/\): R\n/g) ?? []).length, 15, 'All genuine generated visitor returns must preserve R');
    const previous = await readRegular(filename); assert.equal(previous.length, pin.bytes); assert.equal(sha256(previous), pin.sha256);
    assert.equal((previous.toString().match(/DeclarationDescriptorVisitor<[^>\n]*>\?/g) ?? []).length, 2, 'Both generated base parameters must stay nullable');
    const seen = new Set(), sources = [], inventory = [];
    assert(Array.isArray(retainedSources) && retainedSources.length, 'Actual selected Kotlin sources required');
    for (const item of retainedSources) {
        assert(typeof item.path === 'string' && !seen.has(item.path), 'Duplicate selected logical path'); seen.add(item.path);
        const source = await readRegular(item.filename);
        assert.equal(source.length, item.bytes); assert.equal(sha256(source), item.sha256, 'Selected source changed: ' + item.path);
        sources.push({ path: item.path, source }); inventory.push({ path: item.path, bytes: source.length, sha256: sha256(source) });
    }
    const selectedContract = retainedSources.filter(item => item.path === OUTPUT);
    assert.equal(selectedContract.length, 1, 'Nullable descriptor base must remain selected exactly once');
    assert.equal(selectedContract[0].filename, filename, 'Selected descriptor contract differs from canonical predecessor');
    assert.deepEqual(sources.find(item => item.path === OUTPUT).source, previous);
    const selectedVisitor = retainedSources.filter(item => item.path === 'compiler-port-descriptors/generated/DeclarationDescriptorVisitor.kt');
    assert.equal(selectedVisitor.length, 1, 'Genuine generated Visitor must stay selected exactly once');
    assert.equal(selectedVisitor[0].filename, visitorFilename);
    assert.deepEqual(sources.find(item => item.path === selectedVisitor[0].path).source, visitor);
    for (const originalPin of lock.originals) {
        const selected = sources.find(item => item.path === originalPin.path); assert(selected, 'Missing actual visitor-bearing source: ' + originalPin.path);
        assert.deepEqual(selected.source, originals.find(item => item.pin.path === originalPin.path).bytes,
            'Visitor input must precede global host imports and equal original: ' + originalPin.path);
    }
    const guard = inspectVisitorConsumers(sources, lock.contracts);
    const preparedSources = sources.map(item => ({ ...item, source: common.get(item.path) ?? item.source }));
    const afterGuard = inspectVisitorConsumers(preparedSources, lock.contracts, true);
    return { lock, lockBytes, originals, common, previous, guard, afterGuard, inventory,
        visitorBinding: { component: 'descriptorReceipt', componentRelativePath: 'compiler-port-descriptors/generated/DeclarationDescriptorVisitor.kt',
            filename: visitorFilename, bytes: visitor.length, sha256: sha256(visitor), receiptSha256: checked.receiptSha256, preserved: true },
        binding: { component: 'descriptorReceipt', componentRelativePath: OUTPUT, filename,
            bytes: previous.length, sha256: sha256(previous), receiptSha256: checked.receiptSha256, preserved: true } };
}

function receiptFor(input, toolHash) {
    return { schemaVersion: 1, kind: 'selected-descriptor-visitor-null-dispatch-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: toolHash, transformSha256: input.lock.transformSha256,
        originals: input.lock.originals, preservedDescriptorBaseBinding: input.binding, preservedGeneratedVisitorBinding: input.visitorBinding, recipes: input.lock.recipes,
        files: input.lock.preparedOutputs, selectedSourceInventory: input.inventory, guard: input.guard, preparedGuard: input.afterGuard,
        profile: input.lock.profile, originalNullableDeclarationsAndBodiesUnchanged: true,
        javaVisitorNullability: 'Unannotated platform reference; nullable common base retained',
        commonEncoding: 'Only original nonnull generic overrides receive nullable signature plus immediate owner-specific NPE entry check',
        wasmRuntime: 'not-run', fullCompilerBuilt: false, languageReadiness: false };
}

export async function prepareDescriptorVisitorContracts(options) {
    const input = await inputs(options), outputRoot = path.resolve(options.outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    for (const originalRoot of [path.resolve(options.sourceRoot), path.resolve(options.preparedDescriptors.outputRoot)])
        assert(outputRoot !== originalRoot && !outputRoot.startsWith(originalRoot + path.sep) && !originalRoot.startsWith(outputRoot + path.sep), 'Visitor input/output overlap');
    await assertNoSymlink(outputRoot); await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const commonSources = [];
    for (const [logical, bytes] of input.common) {
        const filename = path.join(outputRoot, logical); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        commonSources.push(filename);
    }
    for (const { pin, bytes } of input.originals) {
        const reference = path.join(outputRoot, 'reference', pin.path); await assertNoSymlink(reference);
        await mkdir(path.dirname(reference), { recursive: true, mode: 0o700 }); await writeFile(reference, bytes, { flag: 'wx', mode: 0o600 });
    }
    const receipt = receiptFor(input, sha256(await readRegular(fileURLToPath(import.meta.url))));
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { commonSources, replacedOriginalPaths: [...input.common.keys()], predecessorBindings: [], receipt, receiptPath,
        preservedDescriptorBaseBinding: input.binding, preservedGeneratedVisitorBinding: input.visitorBinding };
}

export async function verifyDescriptorVisitorContracts(options) {
    const input = await inputs(options), profileRoot = path.resolve(options.profileRoot);
    await assertNoSymlink(profileRoot);
    const bytes = await readRegular(path.join(profileRoot, 'receipt.json')), receipt = JSON.parse(bytes);
    assert.deepEqual(receipt, receiptFor(input, sha256(await readRegular(fileURLToPath(import.meta.url)))), 'Visitor receipt changed');
    for (const [logical, output] of input.common) assert.deepEqual(await readRegular(path.join(profileRoot, logical)), output, 'Visitor output changed');
    for (const original of input.originals) assert.deepEqual(await readRegular(path.join(profileRoot, 'reference', original.pin.path)), original.bytes);
    return { receipt, receiptSha256: sha256(bytes) };
}
