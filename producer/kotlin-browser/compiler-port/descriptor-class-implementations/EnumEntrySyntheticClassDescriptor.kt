/* Copyright 2000-2018 JetBrains s.r.o. and Kotlin Programming Language contributors. Apache-2.0. */
package org.jetbrains.kotlin.descriptors.impl

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.incremental.components.LookupLocation
import org.jetbrains.kotlin.incremental.components.NoLookupLocation
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.resolve.NonReportingOverrideStrategy
import org.jetbrains.kotlin.resolve.OverridingUtil
import org.jetbrains.kotlin.resolve.scopes.DescriptorKindFilter
import org.jetbrains.kotlin.resolve.scopes.MemberScope
import org.jetbrains.kotlin.resolve.scopes.MemberScopeImpl
import org.jetbrains.kotlin.storage.*
import org.jetbrains.kotlin.types.*
import org.jetbrains.kotlin.types.checker.KotlinTypeRefiner
import org.jetbrains.kotlin.utils.Printer
import org.jetbrains.kotlin.portable.assertions.compilerAssert

open class EnumEntrySyntheticClassDescriptor private constructor(
    storageManager: StorageManager, containingClass: ClassDescriptor, supertype: KotlinType, name: Name,
    private val enumMemberNames: NotNullLazyValue<Set<Name>>, override val annotations: Annotations, source: SourceElement,
) : ClassDescriptorBase(storageManager, containingClass, name, source, false) {
    private val typeConstructor: TypeConstructor
    private val scope: MemberScope
    init {
        compilerAssert(containingClass.getKind() == ClassKind.ENUM_CLASS)
        typeConstructor = ClassTypeConstructorImpl(this, emptyList(), setOf(supertype), storageManager)
        scope = EnumEntryScope(storageManager)
    }
    public override fun getUnsubstitutedMemberScope(kotlinTypeRefiner: KotlinTypeRefiner): MemberScope = scope
    override fun getStaticScope(): MemberScope = MemberScope.Empty
    override fun getConstructors(): Collection<ClassConstructorDescriptor> = emptyList()
    override fun getTypeConstructor(): TypeConstructor = typeConstructor
    override fun getCompanionObjectDescriptor(): ClassDescriptor? = null
    override fun getKind(): ClassKind = ClassKind.ENUM_ENTRY
    override fun getModality(): Modality = Modality.FINAL
    override fun getVisibility(): DescriptorVisibility = DescriptorVisibilities.PUBLIC
    override fun isInner(): Boolean = false
    override fun isData(): Boolean = false
    override fun isInline(): Boolean = false
    override fun isValue(): Boolean = false
    override fun isFun(): Boolean = false
    override fun isCompanionObject(): Boolean = false
    override fun isExpect(): Boolean = false
    override fun isActual(): Boolean = false
    override fun getUnsubstitutedPrimaryConstructor(): ClassConstructorDescriptor? = null
    override fun toString(): String = "enum entry ${getName()}"
    override fun getDeclaredTypeParameters(): List<TypeParameterDescriptor> = emptyList()
    override fun getSealedSubclasses(): Collection<ClassDescriptor> = emptyList()
    override fun getValueClassRepresentation(): ValueClassRepresentation<SimpleType>? = null
    private open inner class EnumEntryScope(storageManager: StorageManager) : MemberScopeImpl() {
        private val functions: MemoizedFunctionToNotNull<Name, Collection<SimpleFunctionDescriptor>> = storageManager.createMemoizedFunction { computeFunctions(it) }
        private val properties: MemoizedFunctionToNotNull<Name, Collection<PropertyDescriptor>> = storageManager.createMemoizedFunction { computeProperties(it) }
        private val allDescriptors = storageManager.createLazyValue { computeAllDeclarations() }
        override fun getContributedVariables(name: Name, location: LookupLocation): Collection<PropertyDescriptor> = properties(name)
        private fun computeProperties(name: Name): Collection<PropertyDescriptor> = resolveFakeOverrides(name, getSupertypeScope().getContributedVariables(name, NoLookupLocation.FOR_NON_TRACKED_SCOPE))
        override fun getContributedFunctions(name: Name, location: LookupLocation): Collection<SimpleFunctionDescriptor> = functions(name)
        private fun computeFunctions(name: Name): Collection<SimpleFunctionDescriptor> = resolveFakeOverrides(name, getSupertypeScope().getContributedFunctions(name, NoLookupLocation.FOR_NON_TRACKED_SCOPE))
        private fun getSupertypeScope(): MemberScope {
            val supertypes = getTypeConstructor().getSupertypes()
            compilerAssert(supertypes.size == 1) { "Enum entry and its companion object both should have exactly one supertype: $supertypes" }
            return supertypes.iterator().next().memberScope
        }
        private fun <D : CallableMemberDescriptor> resolveFakeOverrides(name: Name, fromSupertypes: Collection<D>): Collection<D> {
            val result = LinkedHashSet<D>()
            OverridingUtil.DEFAULT.generateOverridesInFunctionGroup(name, fromSupertypes, emptySet(), this@EnumEntrySyntheticClassDescriptor,
                object : NonReportingOverrideStrategy() {
                    @Suppress("UNCHECKED_CAST")
                    override fun addFakeOverride(fakeOverride: CallableMemberDescriptor) {
                        OverridingUtil.resolveUnknownVisibilityForMember(fakeOverride, null)
                        result.add(fakeOverride as D)
                    }
                    override fun conflict(fromSuper: CallableMemberDescriptor, fromCurrent: CallableMemberDescriptor) { /* Original deliberately ignores conflicts. */ }
                })
            return result
        }
        override fun getContributedDescriptors(kindFilter: DescriptorKindFilter, nameFilter: (Name) -> Boolean): Collection<DeclarationDescriptor> = allDescriptors()
        private fun computeAllDeclarations(): Collection<DeclarationDescriptor> {
            val result = HashSet<DeclarationDescriptor>()
            for (name in enumMemberNames()) {
                result.addAll(getContributedFunctions(name, NoLookupLocation.FOR_NON_TRACKED_SCOPE))
                result.addAll(getContributedVariables(name, NoLookupLocation.FOR_NON_TRACKED_SCOPE))
            }
            return result
        }
        override fun getFunctionNames(): Set<Name> = enumMemberNames()
        override fun getClassifierNames(): Set<Name> = emptySet()
        override fun getVariableNames(): Set<Name> = enumMemberNames()
        override fun printScopeStructure(p: Printer) { p.println("enum entry scope for ${this@EnumEntrySyntheticClassDescriptor}") }
    }
    companion object {
        @kotlin.jvm.JvmStatic
        fun create(storageManager: StorageManager, enumClass: ClassDescriptor, name: Name,
            enumMemberNames: NotNullLazyValue<Set<Name>>, annotations: Annotations, source: SourceElement): EnumEntrySyntheticClassDescriptor =
            EnumEntrySyntheticClassDescriptor(storageManager, enumClass, enumClass.getDefaultType(), name, enumMemberNames, annotations, source)
    }
}
