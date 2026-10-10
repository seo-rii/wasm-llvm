package org.jetbrains.kotlin.portable.membercomparator.probe

import org.jetbrains.kotlin.builtins.DefaultBuiltIns
import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.descriptors.impl.*
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.metadata.ProtoBuf
import org.jetbrains.kotlin.metadata.deserialization.NameResolverImpl
import org.jetbrains.kotlin.metadata.deserialization.TypeTable
import org.jetbrains.kotlin.metadata.deserialization.VersionRequirementTable
import org.jetbrains.kotlin.resolve.DescriptorFactory
import org.jetbrains.kotlin.resolve.MemberComparator
import org.jetbrains.kotlin.resolve.scopes.MemberScope
import org.jetbrains.kotlin.storage.LockBasedStorageManager
import org.jetbrains.kotlin.serialization.deserialization.descriptors.DeserializedTypeAliasDescriptor
import org.jetbrains.kotlin.types.KotlinType
import org.jetbrains.kotlin.types.Variance

/** Values use real descriptor implementations and the verified bootstrap builtins. */
fun main() {
    val builtIns = DefaultBuiltIns.Instance
    val modules = listOf("alpha", "omega").map {
        ModuleDescriptorImpl(Name.special("<$it>"), LockBasedStorageManager.NO_LOCKS, builtIns).also { module ->
            module.initialize(PackageFragmentProviderImpl(emptyList()))
            module.setDependencies(module)
        }
    }
    val values = mutableListOf<Pair<String, DeclarationDescriptor>>()
    fun klass(owner: DeclarationDescriptor, name: String, kind: ClassKind, companion: Boolean = false): ClassDescriptorImpl =
        object : ClassDescriptorImpl(owner, Name.identifier(name), Modality.FINAL, kind, listOf(builtIns.anyType),
            SourceElement.NO_SOURCE, false, LockBasedStorageManager.NO_LOCKS) {
            override fun isCompanionObject(): Boolean = companion
        }.also { it.initialize(MemberScope.Empty, emptySet(), null) }
    for ([mi, module] in modules.withIndex()) {
        values += "$mi-module" to module
        for (kind in listOf(ClassKind.CLASS, ClassKind.INTERFACE, ClassKind.OBJECT, ClassKind.ENUM_CLASS, ClassKind.ENUM_ENTRY)) {
            for (name in listOf("same", "zeta", "한글")) values += "$mi-class-$kind-$name" to klass(module, name, kind)
        }
        values += "$mi-companion" to klass(module, "same", ClassKind.OBJECT, true)
        val owner = klass(module, "Owner", ClassKind.CLASS)
        for (type in listOf(builtIns.intType, builtIns.stringType)) {
            val alias = DeserializedTypeAliasDescriptor(LockBasedStorageManager.NO_LOCKS, module, Annotations.EMPTY,
                Name.identifier("same"), DescriptorVisibilities.PUBLIC, ProtoBuf.TypeAlias.getDefaultInstance(),
                NameResolverImpl(ProtoBuf.StringTable.getDefaultInstance(), ProtoBuf.QualifiedNameTable.getDefaultInstance()),
                TypeTable(ProtoBuf.TypeTable.getDefaultInstance()), VersionRequirementTable.EMPTY, null)
            alias.initialize(emptyList(), type, type)
            values += "$mi-alias-$type" to alias
        }
        for (kind in CallableMemberDescriptor.Kind.entries) {
            for (receiver in listOf<KotlinType?>(null, builtIns.intType, builtIns.stringType)) {
                for (arity in 0..2) {
                    val function = SimpleFunctionDescriptorImpl.create(owner, Annotations.EMPTY, Name.identifier("same"), kind, SourceElement.NO_SOURCE)
                    val parameters = (0 until arity).map { index ->
                        ValueParameterDescriptorImpl(function, null, index, Annotations.EMPTY, Name.identifier("p$index"),
                            if (index == 0) builtIns.intType else builtIns.stringType, false, false, false, null, SourceElement.NO_SOURCE)
                    }
                    val typeParameter = TypeParameterDescriptorImpl.createWithDefaultBound(function, Annotations.EMPTY, false,
                        Variance.INVARIANT, Name.identifier("T"), 0, LockBasedStorageManager.NO_LOCKS)
                    function.initialize(receiver?.let { DescriptorFactory.createExtensionReceiverParameterForCallable(function, it, Annotations.EMPTY) },
                        null, emptyList(), if (arity == 2) listOf(typeParameter) else emptyList(), parameters, builtIns.unitType,
                        Modality.FINAL, DescriptorVisibilities.PUBLIC)
                    values += "$mi-function-$kind-${receiver?.toString() ?: "none"}-$arity" to function
                }
            }
        }
        for (type in listOf(builtIns.intType, builtIns.stringType)) {
            for (receiver in listOf<KotlinType?>(null, builtIns.intType, builtIns.stringType)) {
                val property = PropertyDescriptorImpl.create(owner, Annotations.EMPTY, Modality.FINAL, DescriptorVisibilities.PUBLIC,
                    true, Name.identifier("same"), CallableMemberDescriptor.Kind.DECLARATION, SourceElement.NO_SOURCE,
                    false, false, false, false, false, false)
                property.setType(type, emptyList(), null,
                    receiver?.let { DescriptorFactory.createExtensionReceiverParameterForCallable(property, it, Annotations.EMPTY) }, emptyList())
                property.initialize(null, null)
                values += "$mi-property-$type-${receiver?.toString() ?: "none"}" to property
            }
        }
        val bounds = listOf(emptyList(), listOf(listOf(builtIns.defaultBound)), listOf(listOf(builtIns.intType)),
            listOf(listOf(builtIns.intType, builtIns.stringType)), listOf(listOf(builtIns.intType), listOf(builtIns.defaultBound)))
        for ([bi, boundLists] in bounds.withIndex()) {
            val function = SimpleFunctionDescriptorImpl.create(owner, Annotations.EMPTY, Name.identifier("same"),
                CallableMemberDescriptor.Kind.DECLARATION, SourceElement.NO_SOURCE)
            val typeParameters = boundLists.mapIndexed { index, upperBounds ->
                TypeParameterDescriptorImpl.createForFurtherModification(function, Annotations.EMPTY, false,
                    Variance.INVARIANT, Name.identifier("T$index"), index, SourceElement.NO_SOURCE, LockBasedStorageManager.NO_LOCKS).also { parameter ->
                    upperBounds.forEach { parameter.addUpperBound(it) }; parameter.setInitialized()
                }
            }
            function.initialize(null, null, emptyList(), typeParameters, emptyList(), builtIns.unitType, Modality.FINAL, DescriptorVisibilities.PUBLIC)
            values += "$mi-function-bounds-$bi" to function
        }
        for (arity in 0..2) {
            val constructor = ClassConstructorDescriptorImpl.create(owner, Annotations.EMPTY, true, SourceElement.NO_SOURCE)
            constructor.initialize((0 until arity).map { index ->
                ValueParameterDescriptorImpl(constructor, null, index, Annotations.EMPTY, Name.identifier("p$index"),
                    if (index == 0) builtIns.intType else builtIns.stringType, false, false, false, null, SourceElement.NO_SOURCE)
            }, DescriptorVisibilities.PUBLIC)
            values += "$mi-constructor-$arity" to constructor
        }
    }
    val comparators = listOf("full" to MemberComparator.INSTANCE, "name-type" to MemberComparator.NameAndTypeMemberComparator.INSTANCE)
    for ([kind, comparator] in comparators) {
        for ([leftId, left] in values) for ([rightId, right] in values) {
            val outcome = try { comparator.compare(left, right).toString() } catch (failure: AssertionError) {
                check(left === right && left is ModuleDescriptor)
                check(failure.message!!.startsWith("Unsupported pair of descriptors:\n'"))
                "AssertionError"
            }
            println("$kind:$leftId:$rightId\t$outcome")
        }
        val sorted = values.sortedWith { left, right -> comparator.compare(left.second, right.second) }
        println("$kind:stable-sort\t${sorted.joinToString("|") { it.first }}")
    }
}
