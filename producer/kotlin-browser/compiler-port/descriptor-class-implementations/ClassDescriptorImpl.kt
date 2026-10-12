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

open class ClassDescriptorImpl(
    containingDeclaration: DeclarationDescriptor, name: Name, private val modality: Modality, private val kind: ClassKind,
    supertypes: Collection<KotlinType>, source: SourceElement, isExternal: Boolean, storageManager: StorageManager,
) : ClassDescriptorBase(storageManager, containingDeclaration, name, source, isExternal) {
    private val typeConstructor: TypeConstructor
    private var unsubstitutedMemberScope: MemberScope? = null
    private var constructors: Set<ClassConstructorDescriptor>? = null
    private var primaryConstructor: ClassConstructorDescriptor? = null
    init {
        compilerAssert(modality != Modality.SEALED) { "Implement getSealedSubclasses() for this class: ${this::class}" }
        typeConstructor = ClassTypeConstructorImpl(this, emptyList(), supertypes, storageManager)
    }
    // Java declares this method final; subclasses customize their virtual descriptor getters.
    fun initialize(unsubstitutedMemberScope: MemberScope, constructors: Set<ClassConstructorDescriptor>, primaryConstructor: ClassConstructorDescriptor?) {
        this.unsubstitutedMemberScope = unsubstitutedMemberScope; this.constructors = constructors; this.primaryConstructor = primaryConstructor
    }
    override val annotations: Annotations get() = Annotations.EMPTY
    override fun getTypeConstructor(): TypeConstructor = typeConstructor
    override fun getConstructors(): Collection<ClassConstructorDescriptor> = constructors!!
    public override fun getUnsubstitutedMemberScope(kotlinTypeRefiner: KotlinTypeRefiner): MemberScope = unsubstitutedMemberScope!!
    override fun getStaticScope(): MemberScope = MemberScope.Empty
    override fun getCompanionObjectDescriptor(): ClassDescriptor? = null
    override fun getKind(): ClassKind = kind
    override fun isCompanionObject(): Boolean = false
    override fun isExpect(): Boolean = false
    override fun isActual(): Boolean = false
    override fun getUnsubstitutedPrimaryConstructor(): ClassConstructorDescriptor? = primaryConstructor
    override fun getModality(): Modality = modality
    override fun getVisibility(): DescriptorVisibility = DescriptorVisibilities.PUBLIC
    override fun isData(): Boolean = false
    override fun isInline(): Boolean = false
    override fun isFun(): Boolean = false
    override fun isValue(): Boolean = false
    override fun isInner(): Boolean = false
    override fun toString(): String = "class ${getName()}"
    override fun getDeclaredTypeParameters(): List<TypeParameterDescriptor> = emptyList()
    override fun getSealedSubclasses(): Collection<ClassDescriptor> = emptyList()
    override fun getValueClassRepresentation(): ValueClassRepresentation<SimpleType>? = null
}
