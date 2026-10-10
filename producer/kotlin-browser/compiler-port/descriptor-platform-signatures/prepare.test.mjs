import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../scripts/source.mjs';
import { applySignatureRecipes, inspectSignatureGraph, signatureDeclarations, IR, GENERATED } from './transform.mjs';
import { verifyDescriptorPlatformSignatures, verifyFinalDescriptorPlatformSignatures } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const lock = JSON.parse(await readFile(path.join(HERE, 'sources.lock.json')));
const seedRoot = process.env.DESCRIPTOR_SIGNATURE_SEED;
assert(seedRoot, 'Exact immutable exited seed required for guards');
const seed = JSON.parse(await readFile(path.join(seedRoot, 'fixture.json'))), sourceMap = new Map();
for (const item of seed.retainedSources) sourceMap.set(item.path, { path: item.path, source: await readFile(item.filename) });

test('nineteen exact nonoverlapping recipes preserve all other bytes and thirteen source-owner checks', () => {
    assert.equal(lock.recipes.length, 19); assert.equal(lock.recipes.flatMap(item => item.checks).length, 13);
    for (const input of lock.inputs) {
        const original = sourceMap.get(input.path).source, expected = lock.outputs.find(item => item.path === input.path);
        assert.equal(original.length, input.bytes); assert.equal(sha256(original), input.sha256);
        const prepared = applySignatureRecipes(original, lock.recipes.filter(item => item.path === input.path));
        assert.equal(prepared.length, expected.bytes); assert.equal(sha256(prepared), expected.sha256);
        assert.equal(signatureDeclarations(prepared).length, signatureDeclarations(original).length);
    }
    const guard = inspectSignatureGraph([...sourceMap.values()], lock.contracts);
    assert.equal(guard.inspectedSources, 3513); assert.equal(guard.declarations.length, 14);
});

test('unknown overrides, escaped names, aliases and signature mutation fail closed', () => {
    const sources = [...sourceMap.values()];
    assert.throws(() => inspectSignatureGraph([...sources, { path: 'Unknown.kt', source: Buffer.from('fun <V> getUserData(key: CallableDescriptor.UserDataKey<V>): V? = null') }], lock.contracts), /Unrecorded/);
    assert.throws(() => signatureDeclarations(Buffer.from('fun `getUserData`(key: UserDataKey<Any>) = null')), /escaped/);
    assert.equal(signatureDeclarations(Buffer.from('fun <V :\n Any?> getUserData(key: UserDataKey<V>): V? = null')).length, 1);
    assert.equal(signatureDeclarations(Buffer.from('fun FirDeclarationStatus.copy(visibility: Visibility?, modality: Modality?, isExpect: Boolean): FirDeclarationStatus = this')).length, 0);
    const missingHeader = sources.map(item => item.path === GENERATED + 'ClassDescriptor.kt' ? { ...item, source: Buffer.from(item.source.toString().replace('typeArguments:', 'renamedArguments:')) } : item);
    assert.throws(() => inspectSignatureGraph(missingHeader, lock.contracts), /declarations changed/);
    assert.throws(() => inspectSignatureGraph([...sources, { path: 'Alias.kt', source: Buffer.from('typealias Hidden = CallableDescriptor') }], lock.contracts), /alias/);
    const original = sourceMap.get(IR).source, recipes = lock.recipes.filter(item => item.path === IR);
    const changed = Buffer.from(original.toString().replace('MutableList<out TypeProjection>', 'MutableList<TypeProjection>'));
    assert.throws(() => applySignatureRecipes(changed, recipes));
});

test('bound nullable predecessor bodies and untouched CopyBuilder/own-getter contracts stay exact', () => {
    const original = sourceMap.get(IR).source, prepared = applySignatureRecipes(original, lock.recipes.filter(item => item.path === IR));
    assert.equal((prepared.toString().match(/getUserData\(key: CallableDescriptor.UserDataKey<V>\?\): V\? = null/g) ?? []).length, 5);
    assert(prepared.toString().includes('override fun getType(): KotlinType = returnType'));
    for (const name of ['CallableMemberDescriptor', 'FunctionDescriptor']) {
        const source = sourceMap.get(GENERATED + name + '.kt').source, output = applySignatureRecipes(source, lock.recipes.filter(item => item.path === GENERATED + name + '.kt'));
        const before = source.toString().slice(source.toString().indexOf('interface CopyBuilder'));
        const after = output.toString().slice(output.toString().indexOf('interface CopyBuilder')); assert.equal(after, before);
    }
});

test('strict preparation and final in-place import replay reject body, owner and unknown import changes', async () => {
    const preparedRoot = process.env.DESCRIPTOR_SIGNATURE_PREPARED, guardRoot = process.env.DESCRIPTOR_SIGNATURE_GUARDS;
    assert(preparedRoot && guardRoot, 'Completed canonical preparation and new private guard root required');
    assert(guardRoot.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(guardRoot, { mode: 0o700 });
    const root = path.join(guardRoot, 'profile'); await cp(preparedRoot, root, { recursive: true });
    const proof = JSON.parse(await readFile(path.join(root, 'proof-preparation.json')));
    const finals = proof.finalSources.map(item => lock.outputs.some(pin => pin.path === item.path) ? { ...item, filename: path.join(root, item.path) } : item);
    await verifyDescriptorPlatformSignatures(root);
    const changed = lock.outputs.find(item => item.path === IR), filename = path.join(root, IR), original = await readFile(filename);
    const text = original.toString(), m = /^package[^\r\n]+/m.exec(text), end = m.index + m[0].length;
    const imports = Buffer.from(text.slice(0, end) + '\nimport kotlin.jvm.*\n' + text.slice(end)); await writeFile(filename, imports);
    const withImports = finals.map(item => item.path === IR ? { ...item, bytes: imports.length, sha256: sha256(imports) } : item);
    const final = await verifyFinalDescriptorPlatformSignatures({ profileRoot: root, retainedSources: withImports, allowedAddedImports: ['kotlin.jvm.*'] });
    assert.equal(final.checked.length, 11);
    await assert.rejects(verifyDescriptorPlatformSignatures(root));
    const unknownImport = Buffer.from(imports.toString().replace('import kotlin.jvm.*', 'import unknown.Unverified'));
    await writeFile(filename, unknownImport);
    await assert.rejects(verifyFinalDescriptorPlatformSignatures({ profileRoot: root, retainedSources: withImports.map(item => item.path === IR ? { ...item, bytes: unknownImport.length, sha256: sha256(unknownImport) } : item), allowedAddedImports: ['kotlin.jvm.*'] }), /Unknown final import/);
    await writeFile(filename, imports);
    const shadow = path.join(guardRoot, 'shadow.kt'); await writeFile(shadow, imports);
    await assert.rejects(verifyFinalDescriptorPlatformSignatures({ profileRoot: root, retainedSources: withImports.map(item => item.path === IR ? { ...item, filename: shadow } : item), allowedAddedImports: ['kotlin.jvm.*'] }), /filename/);
    const bodyMutation = Buffer.from(imports.toString().replace('hasStableParameterNames() = false', 'hasStableParameterNames() = true'));
    assert.notDeepEqual(bodyMutation, imports); await writeFile(filename, bodyMutation);
    await assert.rejects(verifyFinalDescriptorPlatformSignatures({ profileRoot: root, retainedSources: withImports.map(item => item.path === IR ? { ...item, bytes: bodyMutation.length, sha256: sha256(bodyMutation) } : item), allowedAddedImports: ['kotlin.jvm.*'] }), /algorithm/);
    await writeFile(filename, original); assert.equal(sha256(await readFile(filename)), changed.sha256);
});
