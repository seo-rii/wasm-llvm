/* Copyright 2010-2015 JetBrains s.r.o. Apache-2.0. */
package org.jetbrains.kotlin.descriptors.impl

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.CallableDescriptor.UserDataKey
import org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.Kind
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.types.TypeSubstitutor
import org.jetbrains.kotlin.portable.assertions.compilerAssert

abstract class PropertyAccessorDescriptorImpl(
    private val modality: Modality, private var visibility: DescriptorVisibility,
    private val correspondingProperty: PropertyDescriptor, annotations: Annotations, name: Name,
    private var isDefault: Boolean, private val isExternal: Boolean, private val isInline: Boolean,
    private val kind: Kind, source: SourceElement,
) : DeclarationDescriptorNonRootImpl(correspondingProperty.getContainingDeclaration(), annotations, name, source), PropertyAccessorDescriptor {
    private var initialSignatureDescriptor: FunctionDescriptor? = null
    override fun isDefault(): Boolean = isDefault
    open fun setDefault(aDefault: Boolean) { isDefault = aDefault }
    override fun getKind(): Kind = kind
    override fun isOperator(): Boolean = false
    override fun isInfix(): Boolean = false
    override fun isExternal(): Boolean = isExternal
    override fun isInline(): Boolean = isInline
    override fun isTailrec(): Boolean = false
    override fun isSuspend(): Boolean = false
    override fun isExpect(): Boolean = false
    override fun isActual(): Boolean = false
    override fun substitute(substitutor: TypeSubstitutor): FunctionDescriptor = this
    override fun getTypeParameters(): List<TypeParameterDescriptor> = emptyList()
    override fun hasStableParameterNames(): Boolean = false
    override fun hasSynthesizedParameterNames(): Boolean = false
    override fun getModality(): Modality = modality
    override fun getVisibility(): DescriptorVisibility = visibility
    open fun setVisibility(visibility: DescriptorVisibility) { this.visibility = visibility }
    override val correspondingVariable: VariableDescriptorWithAccessors get() = correspondingProperty
    override fun getCorrespondingProperty(): PropertyDescriptor = correspondingProperty
    override fun getContextReceiverParameters(): List<ReceiverParameterDescriptor> = getCorrespondingProperty().getContextReceiverParameters()
    override fun getExtensionReceiverParameter(): ReceiverParameterDescriptor? = getCorrespondingProperty().getExtensionReceiverParameter()
    override fun getDispatchReceiverParameter(): ReceiverParameterDescriptor? = getCorrespondingProperty().getDispatchReceiverParameter()
    override fun newCopyBuilder(): FunctionDescriptor.CopyBuilder<out FunctionDescriptor?> =
        throw UnsupportedOperationException("Accessors must be copied by the corresponding property")
    override fun copy(newOwner: DeclarationDescriptor?, modality: Modality?, visibility: DescriptorVisibility?, kind: Kind?,
        copyOverrides: Boolean): PropertyAccessorDescriptor = throw UnsupportedOperationException("Accessors must be copied by the corresponding property")
    protected open fun getOverriddenDescriptors(isGetter: Boolean): Collection<PropertyAccessorDescriptor> {
        val result = ArrayList<PropertyAccessorDescriptor>(0)
        for (property in getCorrespondingProperty().getOverriddenDescriptors()) {
            val accessor = if (isGetter) property.getter else property.setter
            if (accessor != null) result.add(accessor)
        }
        return result
    }
    override fun setOverriddenDescriptors(overriddenDescriptors: Collection<CallableMemberDescriptor>) {
        compilerAssert(overriddenDescriptors.isEmpty()) { "Overridden accessors should be empty" }
    }
    abstract override fun getOriginal(): PropertyAccessorDescriptor
    override fun getInitialSignatureDescriptor(): FunctionDescriptor? = initialSignatureDescriptor
    open fun setInitialSignatureDescriptor(descriptor: FunctionDescriptor?) { initialSignatureDescriptor = descriptor }
    override fun isHiddenToOvercomeSignatureClash(): Boolean = false
    override fun isHiddenForResolutionEverywhereBesideSupercalls(): Boolean = false
    override fun <V> getUserData(key: UserDataKey<V>?): V? = null
}
