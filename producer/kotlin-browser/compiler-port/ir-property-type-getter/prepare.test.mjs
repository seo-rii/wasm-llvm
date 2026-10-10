import assert from 'node:assert/strict';
import { readFile, cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { sha256 } from '../../scripts/source.mjs';
import { IR, ORIGINAL, PREPARED, applyIrGetterRecipe, inspectIrGetterSelection, algorithm } from './transform.mjs';
import { verifyFinalIrPropertyTypeGetter } from './prepare.mjs';
import { verifyFinalCopyBuilderPlatform } from '../copy-builder-platform/prepare.mjs';
import { verifyFinalDescriptorPlatformSignatures } from '../descriptor-platform-signatures/prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), lock = JSON.parse(await readFile(path.join(HERE, 'sources.lock.json')));
const preparation = process.env.IR_PROPERTY_PREPARATION; assert(preparation);
const receipt = JSON.parse(await readFile(path.join(preparation, 'receipt.json')));
assert.equal(receipt.sourceLockSha256, sha256(await readFile(path.join(HERE, 'sources.lock.json'))));
const before = await readFile(path.join(preparation, 'copy-builder/predecessor', IR));
const selected = JSON.parse(gunzipSync(await readFile(path.join(preparation, 'selected-source-snapshot.json.gz')))).map(item => ({ path: item.path, source: Buffer.from(item.source, 'base64') }));

test('one exact own-getter invocation preserves the entire source and virtual implementation', () => {
    const after = applyIrGetterRecipe(before, lock.recipe);
    assert.equal(after.length, lock.output.bytes); assert.equal(sha256(after), lock.output.sha256);
    assert.equal(before.toString().split(ORIGINAL).length, 2); assert.equal(after.toString().split(PREPARED).length, 2);
    for (const invariant of lock.invariants) assert(after.includes(Buffer.from(invariant)));
});
test('changed source span and arbitrary prepared target fail closed', () => {
    const changed = Buffer.from(before); changed[lock.recipe.startUtf16] ^= 1;
    assert.throws(() => applyIrGetterRecipe(changed, lock.recipe));
    assert.throws(() => applyIrGetterRecipe(before, { ...lock.recipe, prepared: 'override fun getType(): KotlinType = returnType!!' }));
    assert.throws(() => applyIrGetterRecipe(before, { ...lock.recipe, startUtf16: lock.recipe.startUtf16 + 1 }));
});
test('selected class references, openness, source getter and nullable base alias are guarded', () => {
    assert.equal(inspectIrGetterSelection(selected, lock.contracts, lock.invariants).references.length, 1);
    const after = selected.map(item => item.path === IR ? { ...item, source: applyIrGetterRecipe(item.source, lock.recipe) } : item);
    inspectIrGetterSelection(after, lock.contracts, lock.invariants, true);
    assert.throws(() => inspectIrGetterSelection([...after, { path: 'Unknown.kt', source: Buffer.from('fun f(x: IrBasedPropertyDescriptor) = x.getType()') }], lock.contracts, lock.invariants, true), /Unrecorded/);
    assert.throws(() => inspectIrGetterSelection(after.map(item => item.path === IR ? { ...item, source: Buffer.from(item.source.toString().replace('open class IrBasedPropertyDescriptor', 'class IrBasedPropertyDescriptor')) } : item), lock.contracts, lock.invariants, true), /invariant/);
    assert.throws(() => inspectIrGetterSelection(after.map(item => item.path === lock.alias.path ? { ...item, source: Buffer.from(item.source.toString().replace('CallableDescriptor.returnType: org.jetbrains.kotlin.types.KotlinType?', 'CallableDescriptor.returnType: org.jetbrains.kotlin.types.KotlinType')) } : item), lock.contracts, lock.invariants, true), /nullable base/);
});
test('only imports and package header gap are assembly-independent', () => {
    const assembled = before.toString().replace(/(^package[^\n]*\n)/m, '$1\nimport kotlin.jvm.*\n');
    assert.equal(algorithm(Buffer.from(assembled)), algorithm(before));
    assert.notEqual(algorithm(Buffer.from(assembled + '\nval changed = true\n')), algorithm(before));
});
test('actual in-place final assembly yields strict reverse predecessor views', { skip: !process.env.IR_PROPERTY_FINAL_OUTPUT }, async () => {
    const root = path.resolve(process.env.IR_PROPERTY_FINAL_OUTPUT); assert(root.startsWith(path.resolve(HERE, '../../../../out') + path.sep));
    await mkdir(root, { mode: 0o700 }); const profileRoot = path.join(root, 'profile');
    await cp(preparation, profileRoot, { recursive: true, errorOnExist: true, force: false });
    const proof = JSON.parse(await readFile(path.join(preparation, 'proof-preparation.json'))), builderRoot = receipt.predecessor.outputRoot;
    const builderReceipt = JSON.parse(await readFile(path.join(builderRoot, 'receipt.json'))), builderLogical = builderReceipt.files.map(item => item.path);
    // Exact original builder profile copied separately so its own actual four outputs can be import-mutated.
    const builderFinalRoot = path.join(root, 'builder-profile'); await cp(builderRoot, builderFinalRoot, { recursive: true, errorOnExist: true, force: false });
    const allowedAddedImports = ['kotlin.jvm.*', 'org.jetbrains.kotlin.descriptors.*',
        'org.jetbrains.kotlin.portable.assertions.compilerAssert as assert'];
    const finalSources = proof.retainedSources.map(item => item.path === IR ? { ...item, filename: path.join(profileRoot, IR) } :
        builderLogical.includes(item.path) ? { ...item, filename: path.join(builderFinalRoot, item.path) } : item);
    const assembly = [];
    for (const item of finalSources.filter(item => item.path === IR || builderLogical.includes(item.path))) {
        const canonical = await readFile(item.filename); let text = canonical.toString();
        for (const addition of allowedAddedImports) if (!text.includes('import ' + addition + '\n')) text = text.replace(/(^package[^\n]*\n)/m, '$1\nimport ' + addition + '\n');
        const bytes = Buffer.from(text); await writeFile(item.filename, bytes); Object.assign(item, { bytes: bytes.length, sha256: sha256(bytes) });
        assembly.push({ path: item.path, filename: item.filename, canonicalSha256: sha256(canonical), bytes: item.bytes, sha256: item.sha256 });
    }
    const final = await verifyFinalIrPropertyTypeGetter({ profileRoot, retainedSources: finalSources, allowedAddedImports });
    assert.equal(final.receipt.checked.length, 2);
    const builderFinal = await verifyFinalCopyBuilderPlatform({ profileRoot: builderFinalRoot, retainedSources: final.predecessorRetainedSources, allowedAddedImports });
    assert.equal(builderFinal.receipt.checked.length, 4);
    const signatureFinal = await verifyFinalDescriptorPlatformSignatures({ profileRoot: builderReceipt.predecessor.outputRoot, retainedSources: builderFinal.predecessorRetainedSources, allowedAddedImports });
    assert.equal(signatureFinal.checked.length, 11);
    await writeFile(path.join(root, 'receipt.json'), JSON.stringify({ schemaVersion: 1, kind: 'ir-property-real-final-assembly-guards', preparationRoot: preparation,
        preparationReceiptSha256: sha256(await readFile(path.join(preparation, 'receipt.json'))), observerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
        assembly, selectedSources: finalSources.length, final: final.receipt, builderFinal: builderFinal.receipt, signatureFinal,
        negativeEvidence: { publicFinalNegativeCallsExecuted: false, directTransformAndInvariantOnly: true,
            cases: ['changed source span', 'arbitrary replacement', 'wrong offset', 'unrecorded IR class reference', 'changed openness', 'nullable alias narrowing'] },
        actualInPlaceImports: true, originalPredecessorFilesModified: false, fullCompilerBuilt: false, languageReadiness: false }, null, 2) + '\n', { mode: 0o600 });
});
