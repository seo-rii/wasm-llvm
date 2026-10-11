/*
 * Copyright 2010-2015 JetBrains s.r.o.
 * Licensed under the Apache License, Version 2.0.
 */
package org.jetbrains.kotlin.descriptors.impl

import org.jetbrains.kotlin.descriptors.DeclarationDescriptor
import org.jetbrains.kotlin.descriptors.ReceiverParameterDescriptor
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.name.SpecialNames
import org.jetbrains.kotlin.resolve.scopes.receivers.ReceiverValue
import org.jetbrains.kotlin.types.KotlinType
import org.jetbrains.kotlin.types.typeUtil.shouldBeUpdated

open class ReceiverParameterDescriptorImpl(
    private val containingDeclaration: DeclarationDescriptor,
    private var storedValue: ReceiverValue,
    annotations: Annotations,
    name: Name,
) : AbstractReceiverParameterDescriptor(annotations, name) {
    constructor(containingDeclaration: DeclarationDescriptor, value: ReceiverValue, annotations: Annotations) :
        this(containingDeclaration, value, annotations, SpecialNames.THIS)
    override fun getValue(): ReceiverValue = storedValue
    override fun getContainingDeclaration(): DeclarationDescriptor = containingDeclaration
    override fun copy(newOwner: DeclarationDescriptor): ReceiverParameterDescriptor =
        ReceiverParameterDescriptorImpl(newOwner, storedValue, annotations)
    open fun setOutType(outType: KotlinType) {
        if (!storedValue.getType().shouldBeUpdated()) throw AssertionError()
        storedValue = storedValue.replaceType(outType)
    }
}
