/* Copyright 2010-2020 JetBrains s.r.o. and Kotlin Programming Language contributors.
 * Licensed under the Apache License, Version 2.0. */
package org.jetbrains.kotlin.storage

interface SimpleLock {
    fun lock()
    fun unlock()
    companion object {
        fun simpleLock(checkCancelled: (() -> Unit)? = null, interruptedExceptionHandler: ((Throwable) -> Unit)? = null): SimpleLock =
            if (checkCancelled != null && interruptedExceptionHandler != null) CancellableSimpleLock(checkCancelled, interruptedExceptionHandler) else DefaultSimpleLock()
    }
}

inline fun <T> SimpleLock.guarded(crossinline computable: () -> T): T {
    lock()
    return try { computable() } finally { unlock() }
}

// Original NO_LOCKS policy; never replaces default lazy/memoized state machines.
object EmptySimpleLock : SimpleLock {
    override fun lock() {}
    override fun unlock() {}
}

/** Real balanced reentrant ownership for the explicitly single-Worker host. */
open class DefaultSimpleLock : SimpleLock {
    private var depth = 0
    override fun lock() { if (depth == Int.MAX_VALUE) throw IllegalStateException("Storage lock depth overflow"); depth++ }
    override fun unlock() { if (depth == 0) throw IllegalStateException("Storage lock is not held"); depth-- }
}

class CancellableSimpleLock(private val checkCancelled: () -> Unit, private val interruptedExceptionHandler: (Throwable) -> Unit) : DefaultSimpleLock() {
    // Original cancellation callbacks only run while waiting for a contended
    // JVM lock. A serial Worker has no such wait; outer Worker termination
    // handles synchronous compiler cancellation. No interrupt support claimed.
}
