/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.portable.scopes.probe

import java.lang.reflect.Proxy
import java.lang.reflect.Modifier
import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.name.FqName
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.resolve.scopes.*
import org.jetbrains.kotlin.utils.Printer

fun main() {
    val out = mutableListOf<String>()
    fun emit(id: String, value: Any?) { out.add("$id|$value") }
    val fields = DescriptorKindFilter::class.java.fields.filter { Modifier.isStatic(it.modifiers) }
    emit("public-filters", fields.filter { it.type == DescriptorKindFilter::class.java }.joinToString(",") { it.name })
    emit("public-int-fields", fields.filter { it.type == Integer.TYPE }.joinToString(",") { it.name })
    val receiver = Proxy.newProxyInstance(ReceiverParameterDescriptor::class.java.classLoader,
        arrayOf(ReceiverParameterDescriptor::class.java)) { _, _, _ -> null } as ReceiverParameterDescriptor
    fun descriptor(type: Class<*>, kind: ClassKind = ClassKind.CLASS, extension: Boolean = false, fqName: String = "a.b"): DeclarationDescriptor =
        Proxy.newProxyInstance(type.classLoader, arrayOf(type)) { _, method, _ ->
            when (method.name) {
                "getName" -> Name.identifier("item")
                "getKind" -> kind
                "getExtensionReceiverParameter" -> if (extension) receiver else null
                "getFqName" -> FqName(fqName)
                else -> null
            }
        } as DeclarationDescriptor
    val descriptors = listOf(
        descriptor(ClassDescriptor::class.java), descriptor(ClassDescriptor::class.java, ClassKind.OBJECT),
        descriptor(ClassDescriptor::class.java, ClassKind.ENUM_ENTRY), descriptor(TypeAliasDescriptor::class.java),
        descriptor(ClassifierDescriptor::class.java), descriptor(PackageFragmentDescriptor::class.java),
        descriptor(PackageViewDescriptor::class.java), descriptor(FunctionDescriptor::class.java),
        descriptor(FunctionDescriptor::class.java, extension = true), descriptor(VariableDescriptor::class.java),
        descriptor(VariableDescriptor::class.java, extension = true), descriptor(DeclarationDescriptor::class.java),
        descriptor(PackageFragmentDescriptor::class.java, fqName = "a"), descriptor(PackageViewDescriptor::class.java, fqName = "a"),
    )
    val excludes = listOf(emptyList(), listOf(DescriptorKindExclude.Extensions), listOf(DescriptorKindExclude.NonExtensions),
        listOf(DescriptorKindExclude.EnumEntry), listOf(DescriptorKindExclude.TopLevelPackages),
        listOf(DescriptorKindExclude.Extensions, DescriptorKindExclude.NonExtensions),
        listOf(DescriptorKindExclude.EnumEntry, DescriptorKindExclude.EnumEntry))
    val masks = (-8..135).toList() + listOf(Int.MIN_VALUE, Int.MAX_VALUE, 0x10000)
    for (i in masks.indices) for (j in excludes.indices) {
        val mask = masks[i]
        val excluded = excludes[j]
        val filter = DescriptorKindFilter(mask, excluded)
        emit("filter:$i:$j", "${filter.kindMask}:${filter}:${filter == DescriptorKindFilter(mask, excluded)}:${filter.equals(null)}:${filter.equals(mask)}")
        emit("accepts:$i:$j", descriptors.joinToString(",") { filter.accepts(it).toString() })
        emit("exclude:$i:$j", filter.exclude(DescriptorKindExclude.EnumEntry).toString())
        emit("stable-hash:$i:$j", filter.hashCode() == DescriptorKindFilter(mask, excluded).hashCode())
        if (excluded.isEmpty()) emit("raw-empty-hash:$i", filter.hashCode())
        val otherMasks = listOf(0, 1, 2, 7, 16, 48, 63, 127, Int.MIN_VALUE)
        for (k in otherMasks.indices) {
            val otherMask = otherMasks[k]
            emit("ops:$i:$j:$k", "${filter.acceptsKinds(otherMask)}:${filter.withoutKinds(otherMask)}:${filter.withKinds(otherMask)}:${filter.restrictedToKinds(otherMask)}:${filter.restrictedToKindsOrNull(otherMask)}:${filter.intersect(DescriptorKindFilter(otherMask, excluded))}")
        }
    }
    val namedExcludes = listOf(DescriptorKindExclude.Extensions, DescriptorKindExclude.NonExtensions, DescriptorKindExclude.EnumEntry, DescriptorKindExclude.TopLevelPackages)
    for (i in namedExcludes.indices) {
        val exclude = namedExcludes[i]
        emit("exclude-name:$i", exclude.toString())
        emit("exclude-full-mask:$i", exclude.fullyExcludedDescriptorKinds)
    }
    val anonymous = object : DescriptorKindExclude() {
        override val fullyExcludedDescriptorKinds = 0
        override fun excludes(descriptor: DeclarationDescriptor) = false
    }
    emit("exclude-anonymous", anonymous.toString())
    emit("empty-scope", "${MemberScope.Empty.computeAllNames()}:${MemberScope.Empty.definitelyDoesNotContainName(Name.identifier("missing"))}:${MemberScope.Empty.getDescriptorsFiltered()}")
    val scope = object : MemberScopeImpl() {
        override fun printScopeStructure(p: Printer) { p.println("probe scope") }
        override fun getContributedDescriptors(kindFilter: DescriptorKindFilter, nameFilter: (Name) -> Boolean) = descriptors
        override fun getFunctionNames() = setOf(Name.identifier("f"), Name.identifier("duplicate"))
        override fun getVariableNames() = setOf(Name.identifier("v"), Name.identifier("duplicate"))
        override fun getClassifierNames() = setOf(Name.identifier("c"))
    }
    emit("scope-all-names", scope.computeAllNames()?.joinToString(","))
    emit("scope-filter", scope.getDescriptorsFiltered(DescriptorKindFilter.CLASSIFIERS).size)
    emit("scope-name-filter", scope.getDescriptorsFiltered(DescriptorKindFilter.ALL) { false }.size)
    emit("scope-zero-filter", scope.getDescriptorsFiltered(DescriptorKindFilter(0)).size)
    print(out.joinToString("\n", postfix = "\n"))
}
