package org.jetbrains.kotlin.portable.common

import org.jetbrains.kotlin.descriptors.SourceElement
import org.jetbrains.kotlin.descriptors.SourceFile
import org.jetbrains.kotlin.resolve.calls.tasks.ExplicitReceiverKind

val SourceElement.containingFile: SourceFile get() = getContainingFile()
val SourceFile.name: String? get() = getName()
val ExplicitReceiverKind.isExtensionReceiver: Boolean get() = isExtensionReceiver()
val ExplicitReceiverKind.isDispatchReceiver: Boolean get() = isDispatchReceiver()
