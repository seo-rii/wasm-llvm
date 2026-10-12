/* Copyright 2000-2018 JetBrains s.r.o. and Kotlin Programming Language contributors. Apache-2.0. */
package org.jetbrains.kotlin.descriptors.impl

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.resolve.scopes.MemberScope
import org.jetbrains.kotlin.storage.StorageManager
import org.jetbrains.kotlin.types.*
import org.jetbrains.kotlin.types.checker.KotlinTypeRefiner
import org.jetbrains.kotlin.portable.assertions.compilerAssert

open class MutableClassDescriptor(
    containingDeclaration: DeclarationDescriptor,
    private val kind: ClassKind,
    private val inner: Boolean,
    isExternal: Boolean,
    name: Name,
    source: SourceElement,
    private val storageManager: StorageManager,
) : ClassDescriptorBase(storageManager, containingDeclaration, name, source, isExternal) {
    private var modality: Modality? = null
    private var visibility: DescriptorVisibility? = null
    private var typeConstructor: TypeConstructor? = null
    private var typeParameters: List<TypeParameterDescriptor>? = null
    private val supertypes = mutableListOf<KotlinType>()

    init {
        compilerAssert(kind != ClassKind.OBJECT) { "Fix isCompanionObject()" }
    }

    override fun getCompanionObjectDescriptor(): ClassDescriptor? = null
    override val annotations: Annotations get() = Annotations.EMPTY
    open fun setModality(modality: Modality) {
        compilerAssert(modality != Modality.SEALED) { "Implement getSealedSubclasses() for this class: ${this::class}" }
        this.modality = modality
    }
    override fun getModality(): Modality = modality!!
    override fun getKind(): ClassKind = kind
    open fun setVisibility(visibility: DescriptorVisibility) { this.visibility = visibility }
    override fun getVisibility(): DescriptorVisibility = visibility!!
    override fun isInner(): Boolean = inner
    override fun isData(): Boolean = false
    override fun isInline(): Boolean = false
    override fun isFun(): Boolean = false
    override fun isValue(): Boolean = false
    override fun isCompanionObject(): Boolean = false
    override fun isExpect(): Boolean = false
    override fun isActual(): Boolean = false
    override fun getTypeConstructor(): TypeConstructor = typeConstructor!!
    open fun addSupertype(supertype: KotlinType) {
        compilerAssert(!supertype.isError) { "Error types must be filtered out in DescriptorResolver" }
        if (TypeUtils.getClassDescriptor(supertype) != null) supertypes.add(supertype)
    }
    override fun getConstructors(): Set<ClassConstructorDescriptor> = emptySet()
    override fun getUnsubstitutedPrimaryConstructor(): ClassConstructorDescriptor? = null
    open fun setTypeParameterDescriptors(typeParameters: List<TypeParameterDescriptor>) {
        if (this.typeParameters != null) throw IllegalStateException("Type parameters are already set for " + getName())
        this.typeParameters = typeParameters.toMutableList()
    }
    override fun getDeclaredTypeParameters(): List<TypeParameterDescriptor> = typeParameters!!
    open fun createTypeConstructor() {
        compilerAssert(typeConstructor == null) { typeConstructor ?: "null" }
        typeConstructor = ClassTypeConstructorImpl(this, typeParameters!!, supertypes, storageManager)
        for (functionDescriptor in getConstructors()) {
            (functionDescriptor as ClassConstructorDescriptorImpl).setReturnType(getDefaultType())
        }
    }
    public override fun getUnsubstitutedMemberScope(kotlinTypeRefiner: KotlinTypeRefiner): MemberScope = MemberScope.Empty
    override fun getStaticScope(): MemberScope = MemberScope.Empty
    override fun getSealedSubclasses(): Collection<ClassDescriptor> = emptyList()
    override fun getValueClassRepresentation(): ValueClassRepresentation<SimpleType>? = null
    override fun toString(): String = DeclarationDescriptorImpl.toString(this)
}
