/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.portable.descriptors

import org.jetbrains.kotlin.descriptors.impl.FunctionDescriptorImpl

// Typed writable bridges for the Java synthetic properties used by genuine
// FunctionInvokeDescriptor and MemberDeserializer. Each call remains virtual.
var FunctionDescriptorImpl.isOperator: Boolean
    get() = isOperator()
    set(value) = setOperator(value)
var FunctionDescriptorImpl.isInfix: Boolean
    get() = isInfix()
    set(value) = setInfix(value)
var FunctionDescriptorImpl.isExternal: Boolean
    get() = isExternal()
    set(value) = setExternal(value)
var FunctionDescriptorImpl.isInline: Boolean
    get() = isInline()
    set(value) = setInline(value)
var FunctionDescriptorImpl.isTailrec: Boolean
    get() = isTailrec()
    set(value) = setTailrec(value)
var FunctionDescriptorImpl.isSuspend: Boolean
    get() = isSuspend()
    set(value) = setSuspend(value)
var FunctionDescriptorImpl.isExpect: Boolean
    get() = isExpect()
    set(value) = setExpect(value)
