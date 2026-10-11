/*
 * Copyright 2010-2015 JetBrains s.r.o.
 * Licensed under the Apache License, Version 2.0.
 */
package org.jetbrains.kotlin.resolve.scopes.receivers

import org.jetbrains.kotlin.types.KotlinType

abstract class AbstractReceiverValue(
    @kotlin.jvm.JvmField protected val receiverType: KotlinType,
    original: ReceiverValue?,
) : ReceiverValue {
    private val storedOriginal: ReceiverValue = original ?: this
    override fun getType(): KotlinType = receiverType
    override fun getOriginal(): ReceiverValue = storedOriginal
}
