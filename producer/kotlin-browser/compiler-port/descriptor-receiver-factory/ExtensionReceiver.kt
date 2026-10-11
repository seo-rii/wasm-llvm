/*
 * Copyright 2010-2015 JetBrains s.r.o.
 * Licensed under the Apache License, Version 2.0.
 */
package org.jetbrains.kotlin.resolve.scopes.receivers

import org.jetbrains.kotlin.descriptors.CallableDescriptor
import org.jetbrains.kotlin.types.KotlinType

/** Receiver for a pure `this` inside a lambda with a receiver. */
open class ExtensionReceiver(
    private val descriptor: CallableDescriptor,
    receiverType: KotlinType,
    original: ReceiverValue?,
) : AbstractReceiverValue(receiverType, original), ImplicitReceiver {
    override val declarationDescriptor: CallableDescriptor get() = descriptor
    override fun replaceType(newType: KotlinType): ReceiverValue = ExtensionReceiver(descriptor, newType, getOriginal())
    override fun toString(): String = getType().toString() + ": Ext {" + descriptor + "}"
}
