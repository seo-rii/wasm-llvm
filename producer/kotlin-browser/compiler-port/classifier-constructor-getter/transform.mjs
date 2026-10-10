import assert from 'node:assert/strict';
import { sha256 } from '../../scripts/source.mjs';

export const CONSTRUCTOR_PATH = 'core/descriptors/src/org/jetbrains/kotlin/types/ClassifierBasedTypeConstructor.kt';
export const CONTRACT_PATH = 'core/descriptors/src/org/jetbrains/kotlin/types/TypeConstructor.java';
export const OWN_BINDINGS = ['descriptor', 'myDescriptor'];

export function transformClassifierConstructorGetter(bytes, lock) {
    assert(Buffer.isBuffer(bytes));
    assert.equal(bytes.length, lock.predecessor.bytes, 'Identity predecessor size changed');
    assert.equal(sha256(bytes), lock.predecessor.sha256, 'Identity predecessor content changed');
    let text = bytes.toString(); const changes = [];
    assert.equal(text.split('    abstract override fun getDeclarationDescriptor(): ClassifierDescriptor\n').length, 2,
        'Original covariant nonnull getter must remain unchanged');
    for (const variable of OWN_BINDINGS) {
        const before = '        val ' + variable + ' = declarationDescriptor\n';
        const after = '        val ' + variable + ' = getDeclarationDescriptor()\n';
        assert.equal(text.split(before).length, 2, 'Unique own-receiver property binding required: ' + variable);
        const start = text.indexOf(before), original = Buffer.from(before), replacement = Buffer.from(after);
        changes.push({ variable, startUtf16: start, endUtf16: start + before.length,
            originalBytes: original.length, originalSha256: sha256(original),
            replacementBytes: replacement.length, replacementSha256: sha256(replacement) });
        text = text.replace(before, after);
    }
    let restored = text;
    for (const variable of OWN_BINDINGS) restored = restored.replace('        val ' + variable + ' = getDeclarationDescriptor()\n',
        '        val ' + variable + ' = declarationDescriptor\n');
    assert.equal(restored, bytes.toString(), 'Every byte outside the two own getter bindings must remain unchanged');
    assert.equal(text.split('        val otherDescriptor = other.declarationDescriptor ?: return false\n').length, 2,
        'Nullable other-receiver behavior must remain unchanged');
    const output = Buffer.from(text);
    assert.equal(output.length, lock.output.bytes); assert.equal(sha256(output), lock.output.sha256);
    assert.deepEqual(changes, lock.changes);
    return { bytes: output, changes };
}

// The whole class body is projected only for an isolated algorithm observer.
// Its descriptor/type graph is represented by explicitly named payload fixtures,
// never substituted for shipping compiler contracts.
export function projectClassifierConstructor(bytes) {
    const text = bytes.toString();
    assert(text.includes('abstract class ClassifierBasedTypeConstructor : TypeConstructor {'));
    const notice = text.slice(0, text.indexOf('\npackage '));
    let projected = text.slice(text.indexOf('abstract class ClassifierBasedTypeConstructor'));
    const bindings = { ClassifierBasedTypeConstructor: 'ConstructorBoundary', TypeConstructor: 'ConstructorPayload',
        ClassifierDescriptor: 'ClassifierPayload', DeclarationDescriptor: 'DeclarationPayload', ModuleDescriptor: 'ModulePayload',
        PackageFragmentDescriptor: 'PackagePayload', DescriptorUtils: 'DescriptorBoundary', ErrorUtils: 'ErrorBoundary' };
    for (const [before, after] of Object.entries(bindings)) projected = projected.replaceAll(new RegExp('\\b' + before + '\\b', 'g'), after);
    return { bytes: Buffer.from(notice + '\n// Probe-only exact class body; explicit descriptor payload boundary.\n' +
        'package org.jetbrains.kotlin.portable.classifiergetter.probe\n\n' + projected + '\n'),
        bodySha256: sha256(Buffer.from(text.slice(text.indexOf('abstract class ClassifierBasedTypeConstructor')))),
        fixtureTypeBindings: bindings, shippingSource: false, fullClassifierGraph: false };
}
