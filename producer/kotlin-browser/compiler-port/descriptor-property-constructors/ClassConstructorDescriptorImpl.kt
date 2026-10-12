/* Copyright 2010-2017 JetBrains s.r.o. Apache-2.0. */
package org.jetbrains.kotlin.descriptors.impl

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.Kind
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.name.SpecialNames
import org.jetbrains.kotlin.types.TypeSubstitutor
import org.jetbrains.kotlin.portable.assertions.compilerAssert

open class ClassConstructorDescriptorImpl protected constructor(
    containingDeclaration: ClassDescriptor, original: ConstructorDescriptor?, annotations: Annotations,
    @kotlin.jvm.JvmField protected val isPrimary: Boolean, kind: Kind, source: SourceElement,
) : FunctionDescriptorImpl(containingDeclaration, original, annotations, SpecialNames.INIT, kind, source), ClassConstructorDescriptor {
    open fun initialize(unsubstitutedValueParameters: List<ValueParameterDescriptor>, visibility: DescriptorVisibility,
        typeParameterDescriptors: List<TypeParameterDescriptor>): ClassConstructorDescriptorImpl {
        super.initialize(null, calculateDispatchReceiverParameter(), calculateContextReceiverParameters(), typeParameterDescriptors,
            unsubstitutedValueParameters, null, Modality.FINAL, visibility)
        return this
    }
    open fun initialize(unsubstitutedValueParameters: List<ValueParameterDescriptor>, visibility: DescriptorVisibility): ClassConstructorDescriptorImpl {
        initialize(unsubstitutedValueParameters, visibility, getContainingDeclaration().getDeclaredTypeParameters())
        return this
    }
    open fun calculateDispatchReceiverParameter(): ReceiverParameterDescriptor? {
        val descriptor = getContainingDeclaration()
        if (descriptor.isInner()) {
            val container = descriptor.getContainingDeclaration()
            if (container is ClassDescriptor) return container.getThisAsReceiverParameter()
        }
        return null
    }
    private fun calculateContextReceiverParameters(): List<ReceiverParameterDescriptor> {
        val descriptor = getContainingDeclaration()
        if (descriptor.getContextReceivers().isNotEmpty()) return descriptor.getContextReceivers()
        return emptyList()
    }
    override fun getContainingDeclaration(): ClassDescriptor = super.getContainingDeclaration() as ClassDescriptor
    override fun getReturnType(): org.jetbrains.kotlin.types.KotlinType = super.getReturnType()!!
    override fun getConstructedClass(): ClassDescriptor = getContainingDeclaration()
    override fun getOriginal(): ClassConstructorDescriptor = super.getOriginal() as ClassConstructorDescriptor
    override fun substitute(originalSubstitutor: TypeSubstitutor): ClassConstructorDescriptor? = super.substitute(originalSubstitutor) as ClassConstructorDescriptor?
    override fun <R, D> accept(visitor: DeclarationDescriptorVisitor<R, D>?, data: D): R = visitor!!.visitConstructorDescriptor(this, data)
    override fun isPrimary(): Boolean = isPrimary
    override fun getOverriddenDescriptors(): Collection<FunctionDescriptor> = emptySet()
    override fun setOverriddenDescriptors(overriddenDescriptors: Collection<CallableMemberDescriptor>) {
        compilerAssert(overriddenDescriptors.isEmpty()) { "Constructors cannot override anything" }
    }
    override fun createSubstitutedCopy(newOwner: DeclarationDescriptor, original: FunctionDescriptor?, kind: Kind, newName: Name?,
        annotations: Annotations, source: SourceElement): ClassConstructorDescriptorImpl {
        if (kind != Kind.DECLARATION && kind != Kind.SYNTHESIZED) {
            throw IllegalStateException("Attempt at creating a constructor that is not a declaration: \ncopy from: $this\nnewOwner: $newOwner\nkind: $kind")
        }
        compilerAssert(newName == null) { "Attempt to rename constructor: $this" }
        return ClassConstructorDescriptorImpl(newOwner as ClassDescriptor, this, annotations, isPrimary, Kind.DECLARATION, source)
    }
    override fun copy(newOwner: DeclarationDescriptor?, modality: Modality?, visibility: DescriptorVisibility?, kind: Kind?,
        copyOverrides: Boolean): ClassConstructorDescriptor = super.copy(newOwner, modality, visibility, kind, copyOverrides) as ClassConstructorDescriptor
    companion object {
        @kotlin.jvm.JvmStatic
        fun create(containingDeclaration: ClassDescriptor, annotations: Annotations, isPrimary: Boolean, source: SourceElement): ClassConstructorDescriptorImpl =
            ClassConstructorDescriptorImpl(containingDeclaration, null, annotations, isPrimary, Kind.DECLARATION, source)
        @kotlin.jvm.JvmStatic
        fun createSynthesized(containingDeclaration: ClassDescriptor, annotations: Annotations, isPrimary: Boolean, source: SourceElement): ClassConstructorDescriptorImpl =
            ClassConstructorDescriptorImpl(containingDeclaration, null, annotations, isPrimary, Kind.SYNTHESIZED, source)
    }
}
