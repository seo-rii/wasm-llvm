import assert from 'node:assert/strict';
import { encodeVisitorEntries } from '../descriptor-visitor-contract/transform.mjs';
export const VALUE_PARAMETER = 'core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/ValueParameterDescriptorImpl.kt';
export function canonicalVisitorValue(original, visitorLock) {
    return encodeVisitorEntries(original, visitorLock.recipes.filter(row => row.path === VALUE_PARAMETER));
}
export function explicitValueParameterGetters(bytes) {
    let text = bytes.toString();
    const spans = [
        ['override fun getOriginal() = if (original === this) this else original.original',
         'override fun getOriginal() = if (original === this) this else original.getOriginal()'],
        ['return containingDeclaration.overriddenDescriptors.map {',
         'return getContainingDeclaration().overriddenDescriptors.map {'],
    ];
    for (const [before, after] of spans) {
        assert.equal(text.split(before).length, 2, 'Value parameter getter span changed');
        text = text.replace(before, after);
    }
    let reversed = text;
    for (const [before, after] of spans) { assert.equal(reversed.split(after).length, 2); reversed = reversed.replace(after, before); }
    assert.equal(reversed, bytes.toString(), 'Value parameter getter changes are not reversible');
    return Buffer.from(text);
}
