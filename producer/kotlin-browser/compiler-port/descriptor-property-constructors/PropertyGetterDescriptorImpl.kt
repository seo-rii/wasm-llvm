/* Copyright 2010-2015 JetBrains s.r.o. Apache-2.0. */
package org.jetbrains.kotlin.descriptors.impl

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.Kind
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.types.KotlinType

open class PropertyGetterDescriptorImpl(
    correspondingProperty: PropertyDescriptor, annotations: Annotations, modality: Modality, visibility: DescriptorVisibility,
    isDefault: Boolean, isExternal: Boolean, isInline: Boolean, kind: Kind, original: PropertyGetterDescriptor?, source: SourceElement,
) : PropertyAccessorDescriptorImpl(modality, visibility, correspondingProperty, annotations, Name.special("<get-${correspondingProperty.getName()}>"),
    isDefault, isExternal, isInline, kind, source), PropertyGetterDescriptor {
    private var returnType: KotlinType? = null
    private val original: PropertyGetterDescriptor = original ?: this
    open fun initialize(returnType: KotlinType?) { this.returnType = returnType ?: getCorrespondingProperty().getType() }
    @Suppress("UNCHECKED_CAST")
    override fun getOverriddenDescriptors(): Collection<PropertyGetterDescriptor> = super.getOverriddenDescriptors(true) as Collection<PropertyGetterDescriptor>
    override fun getValueParameters(): List<ValueParameterDescriptor> = emptyList()
    override fun getReturnType(): KotlinType? = returnType
    override fun <R, D> accept(visitor: DeclarationDescriptorVisitor<R, D>?, data: D): R = visitor!!.visitPropertyGetterDescriptor(this, data)
    override fun getOriginal(): PropertyGetterDescriptor = original
}
