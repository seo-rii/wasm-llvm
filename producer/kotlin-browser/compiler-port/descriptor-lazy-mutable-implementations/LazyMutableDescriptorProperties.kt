/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.portable.lazymutabledescriptors

import org.jetbrains.kotlin.descriptors.DescriptorVisibility
import org.jetbrains.kotlin.descriptors.Modality
import org.jetbrains.kotlin.descriptors.impl.MutableClassDescriptor

// Keep both genuine virtual calls used by the complete suspend-function consumer.
var MutableClassDescriptor.modality: Modality
    get() = getModality()
    set(value) = setModality(value)
var MutableClassDescriptor.visibility: DescriptorVisibility
    get() = getVisibility()
    set(value) = setVisibility(value)
