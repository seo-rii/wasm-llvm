/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.util.portable

private var currentPerformanceCounterClock: (() -> Long)? = null

/**
 * Synchronous, single-Worker scope. The supplier returns monotonic nanoseconds,
 * with Long wraparound matching System.nanoTime. It must not call compiler code.
 * Restoration also runs when the compiler or the supplier throws. Registries
 * belong to the Wasm module, so a fresh Worker supplies request isolation.
 */
fun <T> withPerformanceCounterClock(nanoTime: () -> Long, block: () -> T): T {
    val previous = currentPerformanceCounterClock
    currentPerformanceCounterClock = nanoTime
    try {
        return block()
    } finally {
        currentPerformanceCounterClock = previous
    }
}

fun performanceCounterNanoTime(): Long = requireNotNull(currentPerformanceCounterClock) {
    "Performance counter clock is not installed for this request"
}.invoke()

/** Single Worker replacement for the counter's two JVM thread-local cells. */
internal class PerformanceCounterWorkerLocal<T> {
    private var value: T? = null
    fun get(): T? = value
    fun set(value: T) { this.value = value }
}
