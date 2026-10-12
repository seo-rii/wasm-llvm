import assert from 'node:assert/strict';
export const TARGET = 'core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/TypeAliasConstructorDescriptor.kt';
export const CLASS_CONSTRUCTOR = 'core/descriptors/src/org/jetbrains/kotlin/descriptors/ClassConstructorDescriptor.kt';
export const CHANGES = [
    { before: 'package org.jetbrains.kotlin.descriptors.impl', after: 'package org.jetbrains.kotlin.descriptors.impl\nimport org.jetbrains.kotlin.portable.typealiasconstructors.isActual\nimport org.jetbrains.kotlin.portable.typealiasconstructors.original\nimport org.jetbrains.kotlin.portable.typealiasconstructors.platformReceiverList' },
    { before: 'underlyingConstructorDescriptor.contextReceiverParameters.map { it.substitute(substitutorForUnderlyingClass) },', after: 'platformReceiverList(underlyingConstructorDescriptor.contextReceiverParameters.map { it.substitute(substitutorForUnderlyingClass) }),' },
    { before: '                contextReceiverParameters,\n                typeAliasDescriptor.declaredTypeParameters,', after: '                platformReceiverList(contextReceiverParameters),\n                typeAliasDescriptor.declaredTypeParameters,' },
];
export function applyBindings(bytes, reverse = false) {
    let text = bytes.toString();
    for (const row of reverse ? CHANGES.slice().reverse() : CHANGES) { const from = reverse ? row.after : row.before, to = reverse ? row.before : row.after;
        assert.equal(text.split(from).length, 2, 'Exact typealias binding anchor required'); text = text.replace(from, to); }
    return Buffer.from(text);
}
