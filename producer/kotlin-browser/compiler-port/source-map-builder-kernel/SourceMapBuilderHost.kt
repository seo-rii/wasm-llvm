/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.portable.sourcemap

import org.jetbrains.kotlin.js.util.AstReaderClosedException
import org.jetbrains.kotlin.js.util.AstSourceReader

/** A supplier owns its fresh reader and its read/close failures. */
fun interface SourceMapContentSupplier {
    fun get(): AstSourceReader?
}

/**
 * Two required caller-owned effects, in the same order as the original builder.
 * Implementations supply real output; native stacktrace text is a host boundary.
 * The builder neither creates a default destination nor closes these destinations.
 */
interface SourceMapEmbeddingDiagnostics {
    fun println(message: String)
    fun reportThrowable(failure: Throwable)
}

class SourceMapBuilderHost(
    val separatorChar: Char,
    val diagnostics: SourceMapEmbeddingDiagnostics,
)

/** Typed IO failures in the two existing, genuine source reader boundaries. */
fun isSourceMapEmbeddingIoFailure(failure: Exception): Boolean =
    failure is SourceMapIoFailure || failure is AstReaderClosedException

/** The selected Kotlin/JVM Reader.copyTo/readText loop uses an 8192-char buffer. */
fun AstSourceReader.readSourceMapEmbeddingText(): String = buildString {
    val buffer = CharArray(8192)
    var count = read(buffer, 0, buffer.size)
    while (count >= 0) {
        appendRange(buffer, 0, count)
        count = read(buffer, 0, buffer.size)
    }
}

/** Kotlin Reader.use semantics: close once, keeping an action failure primary. */
fun <T> AstSourceReader?.useSourceMapEmbeddingReader(action: (AstSourceReader?) -> T): T {
    var failure: Throwable? = null
    try {
        return action(this)
    } catch (error: Throwable) {
        failure = error
        throw error
    } finally {
        if (failure == null) this?.close()
        else try { this?.close() } catch (closeFailure: Throwable) { failure.addSuppressed(closeFailure) }
    }
}
