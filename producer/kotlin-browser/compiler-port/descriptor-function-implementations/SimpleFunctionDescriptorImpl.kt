/*
 * Copyright 2010-2015 JetBrains s.r.o.
 * Licensed under the Apache License, Version 2.0.
 * https://www.apache.org/licenses/LICENSE-2.0
 */
package org.jetbrains.kotlin.descriptors.impl

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.CallableDescriptor.UserDataKey
import org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.Kind
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.types.KotlinType

open class SimpleFunctionDescriptorImpl protected constructor(
    containingDeclaration: DeclarationDescriptor,
    original: SimpleFunctionDescriptor?,
    annotations: Annotations,
    name: Name,
    kind: Kind,
    source: SourceElement,
) : FunctionDescriptorImpl(containingDeclaration, original, annotations, name, kind, source), SimpleFunctionDescriptor {
    @Deprecated("This method is left for binary compatibility with android.nav.safearg plugin. Used in SafeArgSyntheticDescriptorGenerator.kt")
    open fun initialize(extensionReceiverParameter: ReceiverParameterDescriptor?, dispatchReceiverParameter: ReceiverParameterDescriptor?,
        typeParameters: List<TypeParameterDescriptor>, unsubstitutedValueParameters: List<ValueParameterDescriptor>,
        unsubstitutedReturnType: KotlinType?, modality: Modality?, visibility: DescriptorVisibility): SimpleFunctionDescriptorImpl =
        initialize(extensionReceiverParameter, dispatchReceiverParameter, emptyList(), typeParameters, unsubstitutedValueParameters,
            unsubstitutedReturnType, modality, visibility, null)
    override fun initialize(extensionReceiverParameter: ReceiverParameterDescriptor?, dispatchReceiverParameter: ReceiverParameterDescriptor?,
        contextReceiverParameters: List<ReceiverParameterDescriptor>, typeParameters: List<TypeParameterDescriptor>,
        unsubstitutedValueParameters: List<ValueParameterDescriptor>, unsubstitutedReturnType: KotlinType?, modality: Modality?,
        visibility: DescriptorVisibility): SimpleFunctionDescriptorImpl =
        initialize(extensionReceiverParameter, dispatchReceiverParameter, contextReceiverParameters, typeParameters,
            unsubstitutedValueParameters, unsubstitutedReturnType, modality, visibility, null)
    open fun initialize(extensionReceiverParameter: ReceiverParameterDescriptor?, dispatchReceiverParameter: ReceiverParameterDescriptor?,
        contextReceiverParameters: List<ReceiverParameterDescriptor>, typeParameters: List<TypeParameterDescriptor>,
        unsubstitutedValueParameters: List<ValueParameterDescriptor>, unsubstitutedReturnType: KotlinType?, modality: Modality?,
        visibility: DescriptorVisibility, userData: Map<out UserDataKey<*>, *>?): SimpleFunctionDescriptorImpl {
        super.initialize(extensionReceiverParameter, dispatchReceiverParameter, contextReceiverParameters, typeParameters,
            unsubstitutedValueParameters, unsubstitutedReturnType, modality, visibility)
        if (userData != null && userData.isNotEmpty()) userDataMap = LinkedHashMap(userData)
        return this
    }
    override fun getOriginal(): SimpleFunctionDescriptor = super.getOriginal() as SimpleFunctionDescriptor
    override fun createSubstitutedCopy(newOwner: DeclarationDescriptor, original: FunctionDescriptor?, kind: Kind,
        newName: Name?, annotations: Annotations, source: SourceElement): FunctionDescriptorImpl =
        SimpleFunctionDescriptorImpl(newOwner, original as SimpleFunctionDescriptor?, annotations, newName ?: getName(), kind, source)
    override fun copy(newOwner: DeclarationDescriptor?, modality: Modality?, visibility: DescriptorVisibility?, kind: Kind?,
        copyOverrides: Boolean): SimpleFunctionDescriptor = super.copy(newOwner, modality, visibility, kind, copyOverrides) as SimpleFunctionDescriptor
    @Suppress("UNCHECKED_CAST")
    override fun newCopyBuilder(): FunctionDescriptor.CopyBuilder<out SimpleFunctionDescriptor?> =
        super.newCopyBuilder() as FunctionDescriptor.CopyBuilder<out SimpleFunctionDescriptor?>
    companion object {
        @kotlin.jvm.JvmStatic
        fun create(containingDeclaration: DeclarationDescriptor, annotations: Annotations, name: Name, kind: Kind,
            source: SourceElement): SimpleFunctionDescriptorImpl = SimpleFunctionDescriptorImpl(containingDeclaration, null, annotations, name, kind, source)
    }
}
