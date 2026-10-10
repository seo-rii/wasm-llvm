package org.jetbrains.kotlin.portable.classifiergetter.actual

import org.jetbrains.kotlin.builtins.DefaultBuiltIns
import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.descriptors.impl.*
import org.jetbrains.kotlin.name.FqName
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.resolve.scopes.MemberScope
import org.jetbrains.kotlin.storage.LockBasedStorageManager
import org.jetbrains.kotlin.types.ClassTypeConstructorImpl
import org.jetbrains.kotlin.types.ClassifierBasedTypeConstructor
import org.jetbrains.kotlin.types.TypeConstructor
import org.jetbrains.kotlin.types.error.ErrorUtils

/** Full source algorithm executes with genuine verified-bootstrap descriptor objects. */
fun main() {
    val builtins = DefaultBuiltIns.Instance
    val storage = LockBasedStorageManager.NO_LOCKS
    fun record(id: String, value: Any?) { println("$id\t$value") }
    val modules = listOf("alpha", "beta").map { label ->
        ModuleDescriptorImpl(Name.special("<$label>"), storage, builtins).also {
            it.initialize(PackageFragmentProviderImpl(emptyList())); it.setDependencies(it)
        }
    }
    fun klass(owner: DeclarationDescriptor, name: String) = ClassDescriptorImpl(owner, Name.identifier(name), Modality.FINAL,
        ClassKind.CLASS, listOf(builtins.anyType), SourceElement.NO_SOURCE, false, storage).also {
        it.initialize(MemberScope.Empty, emptySet(), null)
    }
    val descriptors = mutableListOf<Pair<String, ClassDescriptor>>()
    descriptors += "builtin-any" to builtins.any
    descriptors += "builtin-string" to builtins.string
    descriptors += "builtin-list" to builtins.list
    descriptors += "error" to ErrorUtils.errorClass
    for ([mi, module] in modules.withIndex()) {
        for (pkg in listOf("same", "different")) {
            val fragment = EmptyPackageFragmentDescriptor(module, FqName(pkg))
            for (name in listOf("Same", "Other", "한글")) {
                val outer = klass(fragment, name); descriptors += "$mi-$pkg-$name" to outer
                descriptors += "$mi-$pkg-$name-nested" to klass(outer, "Inner")
            }
        }
        val function = SimpleFunctionDescriptorImpl.create(module, Annotations.EMPTY, Name.identifier("localOwner"),
            CallableMemberDescriptor.Kind.DECLARATION, SourceElement.NO_SOURCE)
        descriptors += "$mi-local" to klass(function, "Local")
    }
    val values = descriptors.map { [label, descriptor] ->
        label to ClassTypeConstructorImpl(descriptor, descriptor.declaredTypeParameters, descriptor.typeConstructor.getSupertypes(), storage)
    }.toMutableList()
    val list = values.first { it.first == "builtin-list" }.second
    values += "builtin-list-no-parameters" to ClassTypeConstructorImpl(builtins.list, emptyList(), list.getSupertypes(), storage)
    values += "same-reference" to values.first().second
    values += "second-same-classifier" to ClassTypeConstructorImpl(builtins.any, emptyList(), builtins.anyType.constructor.getSupertypes(), storage)
    for ([index, entry] in values.withIndex()) {
        val value = entry.second
        val own: ClassifierDescriptor = (value as ClassifierBasedTypeConstructor).getDeclarationDescriptor()
        val base: ClassifierDescriptor? = (value as TypeConstructor).getDeclarationDescriptor()
        record("own-covariant-$index", own === base)
        val hash = value.hashCode()
        record("hash-stable-$index", (0 until 32).all { value.hashCode() == hash })
        record("null-$index", value.equals(null)); record("wrong-type-$index", value.equals("unrelated"))
        for ([oi, other] in values.withIndex()) {
            record("equals-$index-$oi", value == other.second)
            record("equal-hash-$index-$oi", value != other.second || value.hashCode() == other.second.hashCode())
        }
    }
    // Meaningful names use exact FqName hashing; local/error identity numbers are
    // deliberately observed only through stability and equal=>same-hash contracts.
    record("meaningful-numeric-hash", values.first { it.first == "builtin-string" }.second.hashCode())
}
