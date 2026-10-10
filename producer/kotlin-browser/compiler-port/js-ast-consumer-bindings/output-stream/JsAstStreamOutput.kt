/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.portable

/** Request-owned byte output. Implementations consume the requested slice synchronously. */
interface CompilerByteSink {
    fun write(bytes: ByteArray, offset: Int, length: Int)
    fun flush()
    fun close()
}

/** Selected AST stream operations; one request on one Worker owns this instance. */
class JsAstStreamOutput(private val sink: CompilerByteSink) {
    private val primitive = ByteArray(8)
    private var closed = false

    fun writeInt(value: Int) {
        for (index in 0..3) primitive[index] = (value ushr (24 - index * 8)).toByte()
        sink.write(primitive, 0, 4)
    }

    fun write(bytes: ByteArray) = sink.write(bytes, 0, bytes.size)

    fun close() {
        if (closed) return
        closed = true
        var flushFailure: Throwable? = null
        try { sink.flush() } catch (error: Throwable) { flushFailure = error }
        try {
            sink.close()
        } catch (closeFailure: Throwable) {
            if (flushFailure != null && flushFailure !== closeFailure) closeFailure.addSuppressed(flushFailure)
            throw closeFailure
        }
        if (flushFailure != null) throw flushFailure
    }
}

/** Action failure stays primary; a later close failure is retained through suppression. */
fun <T> JsAstStreamOutput.useJsAstOutput(action: (JsAstStreamOutput) -> T): T {
    var failure: Throwable? = null
    try {
        return action(this)
    } catch (error: Throwable) {
        failure = error
        throw error
    } finally {
        if (failure == null) close()
        else try { close() } catch (closeFailure: Throwable) { failure.addSuppressed(closeFailure) }
    }
}
