/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.portable.typealiasconstructors

import org.jetbrains.kotlin.descriptors.ClassConstructorDescriptor
import org.jetbrains.kotlin.descriptors.ReceiverParameterDescriptor
import org.jetbrains.kotlin.descriptors.impl.FunctionDescriptorImpl

var FunctionDescriptorImpl.isActual: Boolean
    get() = isActual()
    set(value) = setActual(value)

val ClassConstructorDescriptor.original: ClassConstructorDescriptor
    get() = getOriginal()

// The original Java initialize call accepts this erased list without reading,
// filtering, copying, or rejecting nullable receiver elements at this boundary.
@Suppress("UNCHECKED_CAST")
fun platformReceiverList(receivers: List<ReceiverParameterDescriptor?>): List<ReceiverParameterDescriptor> =
    receivers as List<ReceiverParameterDescriptor>
