/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.portable.classdescriptors

import org.jetbrains.kotlin.descriptors.CallableMemberDescriptor
import org.jetbrains.kotlin.descriptors.impl.ClassConstructorDescriptorImpl
import org.jetbrains.kotlin.types.KotlinType

// The complete genuine ErrorClassDescriptor initializes its constructor through
// the Java synthetic property. Keep the annotated getter and both virtual calls.
var ClassConstructorDescriptorImpl.returnType: KotlinType
    get() = getReturnType()
    set(value) = setReturnType(value)

// The complete genuine OverridingStrategy assigns the Java writable property.
var CallableMemberDescriptor.overriddenDescriptors: Collection<CallableMemberDescriptor>
    get() = getOverriddenDescriptors()
    set(value) = setOverriddenDescriptors(value)
