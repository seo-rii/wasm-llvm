/* Copyright 2010-2015 JetBrains s.r.o. Apache-2.0. */
package org.jetbrains.kotlin.descriptors.impl

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.resolve.scopes.receivers.ImplicitClassReceiver
import org.jetbrains.kotlin.resolve.scopes.receivers.ReceiverValue

open class LazyClassReceiverParameterDescriptor(private val descriptor: ClassDescriptor) : AbstractReceiverParameterDescriptor(Annotations.EMPTY) {
    private val receiverValue = ImplicitClassReceiver(descriptor, null)
    override fun getValue(): ReceiverValue = receiverValue
    override fun getContainingDeclaration(): DeclarationDescriptor = descriptor
    override fun copy(newOwner: DeclarationDescriptor): ReceiverParameterDescriptor = throw UnsupportedOperationException()
    override fun toString(): String = "class ${descriptor.getName()}::this"
}
