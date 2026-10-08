/* Copyright 2010-2016 JetBrains s.r.o. Apache License 2.0; see source recipe. */
package org.jetbrains.kotlin.resolve.calls.tasks

enum class ExplicitReceiverKind {
    EXTENSION_RECEIVER, DISPATCH_RECEIVER, NO_EXPLICIT_RECEIVER, BOTH_RECEIVERS;
    fun isExtensionReceiver(): Boolean = this == EXTENSION_RECEIVER || this == BOTH_RECEIVERS
    fun isDispatchReceiver(): Boolean = this == DISPATCH_RECEIVER || this == BOTH_RECEIVERS
}
