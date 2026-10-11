/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.portable.descriptorbases

import org.jetbrains.kotlin.descriptors.DeclarationDescriptor

/** Actual host diagnostics; implementations must not call descriptor.equals/hashCode. */
interface DescriptorDebugHost {
    fun classSimpleName(descriptor: DeclarationDescriptor): String
    fun identityHashCode(descriptor: DeclarationDescriptor): Int
}

/** Request-scoped within one serial compiler Worker; nested calls restore their caller. */
object DescriptorDebugHostContext {
    private var host: DescriptorDebugHost? = null
    fun current(): DescriptorDebugHost = checkNotNull(host) { "Descriptor debug host is not installed" }
    fun <T> withHost(value: DescriptorDebugHost, block: () -> T): T {
        val previous = host
        host = value
        try { return block() } finally { host = previous }
    }
}

fun <T> withDescriptorDebugHost(host: DescriptorDebugHost, block: () -> T): T =
    DescriptorDebugHostContext.withHost(host, block)
