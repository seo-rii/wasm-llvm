import assert from 'node:assert/strict';
import { sha256 } from '../../scripts/source.mjs';
import { maskCode, algorithm } from '../descriptor-platform-signatures/transform.mjs';
export { algorithm };
export const IR = 'compiler/ir/ir.tree/src/org/jetbrains/kotlin/ir/descriptors/IrBasedDescriptors.kt';
export const ALIAS = 'compiler-port-descriptors/generated/DescriptorProperties.kt';
export const ORIGINAL = 'override fun getType(): KotlinType = returnType';
export const PREPARED = 'override fun getType(): KotlinType = getReturnType()';

export function applyIrGetterRecipe(bytes, recipe) {
    const original = bytes.toString();
    assert.equal(recipe.path, IR); assert.equal(recipe.original, ORIGINAL); assert.equal(recipe.prepared, PREPARED);
    assert(Number.isSafeInteger(recipe.startUtf16) && Number.isSafeInteger(recipe.endUtf16));
    assert(recipe.startUtf16 >= 0 && recipe.endUtf16 <= original.length);
    assert.equal(original.slice(recipe.startUtf16, recipe.endUtf16), ORIGINAL);
    assert.equal(Buffer.byteLength(ORIGINAL), recipe.originalBytes); assert.equal(sha256(Buffer.from(ORIGINAL)), recipe.originalSha256);
    assert.equal(Buffer.byteLength(PREPARED), recipe.preparedBytes); assert.equal(sha256(Buffer.from(PREPARED)), recipe.preparedSha256);
    const result = original.slice(0, recipe.startUtf16) + PREPARED + original.slice(recipe.endUtf16);
    assert.deepEqual(Buffer.from(result.slice(0, recipe.startUtf16) + ORIGINAL + result.slice(recipe.startUtf16 + PREPARED.length)), bytes,
        'Untargeted IR source bytes changed');
    return Buffer.from(result);
}

export function inspectIrGetterSelection(sources, contracts, invariants, prepared = false) {
    const wanted = new Map(contracts.map(item => [item.path, item.references])), seen = new Set(), references = [];
    for (const { path, source } of sources) {
        assert(!seen.has(path)); seen.add(path); const text = source.toString(), code = maskCode(text);
        assert(!/`IrBasedPropertyDescriptor`/.test(code), 'Unreviewed escaped IR property name');
        assert(!/^\s*typealias\s+[^\n]*\bIrBasedPropertyDescriptor\b/m.test(code), 'Unreviewed IR property type alias');
        assert(!/^import\s+[^\n]*\bIrBasedPropertyDescriptor\s+as\s+/m.test(code), 'Unreviewed IR property import alias');
        const count = [...code.matchAll(/\bIrBasedPropertyDescriptor\b/g)].length;
        if (count || wanted.has(path)) { assert(wanted.has(path), 'Unrecorded selected IR property reference: ' + path);
            assert.equal(count, wanted.get(path), 'Selected IR property reference count changed: ' + path); references.push({ path, references: count }); }
        if (path === IR) {
            for (const invariant of invariants) assert.equal(text.split(invariant).length, 2, 'IR getter invariant changed');
            assert.equal(text.split(prepared ? PREPARED : ORIGINAL).length, 2);
        }
        if (path === ALIAS) {
            assert.equal(text.split('val org.jetbrains.kotlin.descriptors.CallableDescriptor.returnType: org.jetbrains.kotlin.types.KotlinType? get() = getReturnType()').length, 2,
                'The nullable base CallableDescriptor alias must remain unchanged');
        }
    }
    assert(seen.has(IR) && seen.has(ALIAS)); for (const logical of wanted.keys()) assert(seen.has(logical));
    return { inspectedSources: sources.length, references, openGetterDispatchRetained: true, nullableBaseAliasRetained: true,
        lexicalOnly: true, limitation: 'Source-bound full-file replacement and exact known lexical IR class references; arbitrary aliases, inheritance, reflection and string interpolation are unresolved. Runtime evidence covers genuine selected receivers, not every descriptor.' };
}
