/* Copyright 2010-2015 JetBrains s.r.o. Apache-2.0. */
package org.jetbrains.kotlin.descriptors.impl

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.Kind
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.name.SpecialNames
import org.jetbrains.kotlin.types.KotlinType
import org.jetbrains.kotlin.resolve.descriptorUtil.builtIns
import org.jetbrains.kotlin.portable.assertions.compilerAssert

open class PropertySetterDescriptorImpl(
    correspondingProperty: PropertyDescriptor, annotations: Annotations, modality: Modality, visibility: DescriptorVisibility,
    isDefault: Boolean, isExternal: Boolean, isInline: Boolean, kind: Kind, original: PropertySetterDescriptor?, source: SourceElement,
) : PropertyAccessorDescriptorImpl(modality, visibility, correspondingProperty, annotations, Name.special("<set-${correspondingProperty.getName()}>"),
    isDefault, isExternal, isInline, kind, source), PropertySetterDescriptor {
    private var parameter: ValueParameterDescriptor? = null
    private val original: PropertySetterDescriptor = original ?: this
    open fun initialize(parameter: ValueParameterDescriptor) { compilerAssert(this.parameter == null); this.parameter = parameter }
    open fun initializeDefault() { initialize(createSetterParameter(this, getCorrespondingProperty().getType(), Annotations.EMPTY)) }
    @Suppress("UNCHECKED_CAST")
    override fun getOverriddenDescriptors(): Collection<PropertySetterDescriptor> = super.getOverriddenDescriptors(false) as Collection<PropertySetterDescriptor>
    override fun getValueParameters(): List<ValueParameterDescriptor> {
        val parameter = parameter ?: throw IllegalStateException()
        return listOf(parameter)
    }
    override fun getReturnType(): KotlinType = builtIns.unitType
    override fun <R, D> accept(visitor: DeclarationDescriptorVisitor<R, D>?, data: D): R = visitor!!.visitPropertySetterDescriptor(this, data)
    override fun getOriginal(): PropertySetterDescriptor = original
    companion object {
        @kotlin.jvm.JvmStatic
        fun createSetterParameter(setterDescriptor: PropertySetterDescriptor, type: KotlinType, annotations: Annotations): ValueParameterDescriptorImpl =
            ValueParameterDescriptorImpl(setterDescriptor, null, 0, annotations, SpecialNames.IMPLICIT_SET_PARAMETER, type, false, false, false, null, SourceElement.NO_SOURCE)
    }
}
