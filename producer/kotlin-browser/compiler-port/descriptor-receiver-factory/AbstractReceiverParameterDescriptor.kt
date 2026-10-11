/*
 * Copyright 2010-2015 JetBrains s.r.o.
 * Licensed under the Apache License, Version 2.0.
 */
package org.jetbrains.kotlin.descriptors.impl

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.name.SpecialNames
import org.jetbrains.kotlin.resolve.scopes.receivers.TransientReceiver
import org.jetbrains.kotlin.types.KotlinType
import org.jetbrains.kotlin.types.TypeSubstitutor
import org.jetbrains.kotlin.types.Variance

abstract class AbstractReceiverParameterDescriptor : DeclarationDescriptorImpl, ReceiverParameterDescriptor {
    constructor(annotations: Annotations) : super(annotations, SpecialNames.THIS)
    constructor(annotations: Annotations, name: Name) : super(annotations, name)

    override fun substitute(substitutor: TypeSubstitutor): ReceiverParameterDescriptor? {
        if (substitutor.isEmpty()) return this
        // Dispatch parameters use their upper approximation, exactly as the Java implementation.
        val substitutedType = substitutor.substitute(getType(),
            if (getContainingDeclaration() is ClassDescriptor) Variance.OUT_VARIANCE else Variance.INVARIANT)
            ?: return null
        if (substitutedType === getType()) return this
        return ReceiverParameterDescriptorImpl(getContainingDeclaration(), TransientReceiver(substitutedType), annotations)
    }

    override fun <R, D> accept(visitor: DeclarationDescriptorVisitor<R, D>?, data: D): R? =
        visitor!!.visitReceiverParameterDescriptor(this, data)
    override fun getContextReceiverParameters(): List<ReceiverParameterDescriptor> = emptyList()
    override fun getExtensionReceiverParameter(): ReceiverParameterDescriptor? = null
    override fun getDispatchReceiverParameter(): ReceiverParameterDescriptor? = null
    override fun getTypeParameters(): List<TypeParameterDescriptor> = emptyList()
    override fun getReturnType(): KotlinType = getType()
    override fun getType(): KotlinType = getValue().getType()
    override fun getValueParameters(): List<ValueParameterDescriptor> = emptyList()
    override fun hasStableParameterNames(): Boolean = false
    override fun hasSynthesizedParameterNames(): Boolean = false
    override fun getOverriddenDescriptors(): Collection<CallableDescriptor> = emptySet()
    override fun getVisibility(): DescriptorVisibility = DescriptorVisibilities.LOCAL
    override fun getOriginal(): ParameterDescriptor = this
    override fun getSource(): SourceElement = SourceElement.NO_SOURCE
    override fun <V> getUserData(key: CallableDescriptor.UserDataKey<V>?): V? = null
}
