/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.portable.sourcemap

import org.jetbrains.kotlin.js.portable.CompilerByteSink
import org.jetbrains.kotlin.portable.text.compilerUtf8Bytes
import org.jetbrains.kotlin.portable.text.compilerUtf8String

/** IO failure at the explicit source-map host boundary, outside Java namespaces. */
open class SourceMapIoFailure(message: String) : Exception(message)

/** Selected Java try-with-resources behavior, including rejecting self suppression. */
private fun withSourceMapResource(close: () -> Unit, action: () -> Unit) {
    var failure: Throwable? = null
    try { action() } catch (error: Throwable) { failure = error; throw error }
    finally {
        try { close() } catch (closeFailure: Throwable) {
            if (failure == null) throw closeFailure
            if (failure === closeFailure) throw IllegalArgumentException("Self-suppression not permitted", closeFailure)
            failure.addSuppressed(closeFailure)
        }
    }
}

/** Single-request UTF8 encoder with an 8192-byte buffer and cross-write surrogate carry. */
private class SourceMapUtf8Output(private val sink: CompilerByteSink) {
    private val bytes = ByteArray(8192)
    private var position = 0
    private var limit = bytes.size
    private var pendingHigh: Char? = null
    private var closed = false

    private fun ensureOpen() { if (closed) throw SourceMapIoFailure("Stream closed") }

    private fun encode(text: String) {
        val encoded = text.compilerUtf8Bytes()
        var offset = 0
        while (offset < encoded.size) {
            val leading = encoded[offset].toInt() and 255
            val count = when { leading < 128 -> 1; leading < 224 -> 2; leading < 240 -> 3; else -> 4 }
            if (count > limit - position) {
                // Encoder overflow invokes the JDK writeBytes path even with an
                // empty flipped buffer left by a prior failed write. That path
                // restores capacity without calling the sink for zero bytes.
                if (position == 0) limit = bytes.size else flushBuffer()
            }
            // A failed sink write retains the encoder's flipped buffer limit,
            // just as the selected JDK byte encoder. Allocation is never faked.
            if (count > limit - position) throw AssertionError("No UTF8 output space")
            encoded.copyInto(bytes, position, offset, offset + count)
            position += count
            offset += count
        }
    }

    fun write(text: String) {
        ensureOpen()
        var offset = 0
        while (pendingHigh != null && offset < text.length) {
            val next = text[offset++]
            val pair = "${pendingHigh!!}$next"
            if (next.isHighSurrogate()) {
                encode(pair.substring(0, 1))
                pendingHigh = next
            } else {
                encode(pair)
                pendingHigh = null
            }
        }
        if (offset == text.length) return
        val hasPending = text.last().isHighSurrogate()
        val end = if (hasPending) text.length - 1 else text.length
        encode(text.substring(offset, end))
        if (hasPending) pendingHigh = text.last()
    }

    fun flushBuffer() {
        ensureOpen()
        if (position == 0) return
        limit = position
        position = 0
        sink.write(bytes, 0, limit)
        limit = bytes.size
    }

    fun flush() { flushBuffer(); sink.flush() }

    fun close() {
        if (closed) return
        try {
            withSourceMapResource({ sink.close() }) {
                pendingHigh?.let { encode(it.toString()); pendingHigh = null }
                flushBuffer()
                sink.flush()
            }
        } finally { closed = true }
    }
}

/** Buffered synchronous character writer used by the genuine source-map JSON host. */
class SourceMapBufferedUtf8Writer(sink: CompilerByteSink) : Appendable {
    private val output = SourceMapUtf8Output(sink)
    private val chars = CharArray(8192)
    private var count = 0
    private var closed = false

    private fun ensureOpen() { if (closed) throw SourceMapIoFailure("Stream closed") }
    internal fun flushCharacters() {
        ensureOpen()
        if (count == 0) return
        output.write(chars.concatToString(0, count))
        count = 0
    }
    internal fun drainWithoutSinkFlush() { flushCharacters(); output.flushBuffer() }

    override fun append(value: Char): SourceMapBufferedUtf8Writer {
        ensureOpen()
        if (count == chars.size) flushCharacters()
        chars[count++] = value
        return this
    }
    override fun append(value: CharSequence?): SourceMapBufferedUtf8Writer = append(value, 0, value?.length ?: 4)
    override fun append(value: CharSequence?, startIndex: Int, endIndex: Int): SourceMapBufferedUtf8Writer {
        ensureOpen()
        val text = value ?: "null"
        if (startIndex < 0 || endIndex > text.length || startIndex > endIndex) throw IndexOutOfBoundsException()
        var offset = startIndex
        while (offset < endIndex) {
            val length = minOf(chars.size - count, endIndex - offset)
            for (index in 0 until length) chars[count + index] = text[offset + index]
            offset += length
            count += length
            if (count == chars.size) flushCharacters()
        }
        return this
    }
    fun flush() { flushCharacters(); output.flush() }
    fun close() {
        if (closed) return
        try {
            withSourceMapResource({ output.close() }) { flushCharacters() }
        } finally { closed = true }
    }
}

fun <T> SourceMapBufferedUtf8Writer.useSourceMapWriter(action: (SourceMapBufferedUtf8Writer) -> T): T {
    var failure: Throwable? = null
    try { return action(this) } catch (error: Throwable) { failure = error; throw error }
    finally {
        if (failure == null) close()
        else try { close() } catch (closeFailure: Throwable) { failure.addSuppressed(closeFailure) }
    }
}

/** Selected PrintStream effects over an actual byte sink; IO errors set a sticky error flag. */
class SourceMapPrintOutput(private val sink: CompilerByteSink, private val autoFlush: Boolean = false) {
    private var trouble = false
    private var closed = false
    private var closing = false
    private val writer = SourceMapBufferedUtf8Writer(object : CompilerByteSink {
        override fun write(bytes: ByteArray, offset: Int, length: Int) {
            ioOperation {
                sink.write(bytes, offset, length)
                if (autoFlush) sink.flush()
            }
        }
        override fun flush() = this@SourceMapPrintOutput.flush()
        override fun close() = this@SourceMapPrintOutput.close()
    })

    private fun ioOperation(action: () -> Unit) {
        try {
            if (closed) throw SourceMapIoFailure("Stream closed")
            action()
        } catch (error: SourceMapIoFailure) { trouble = true }
    }
    fun print(value: String?) = ioOperation {
        val text = value ?: "null"
        writer.append(text)
        writer.drainWithoutSinkFlush()
        if (autoFlush && '\n' in text) sink.flush()
    }
    fun print(value: Char) = print(value.toString())
    fun println() = ioOperation {
        writer.append('\n')
        writer.drainWithoutSinkFlush()
        if (autoFlush) sink.flush()
    }
    fun flush() = ioOperation { sink.flush() }
    fun checkError(): Boolean { if (!closed) flush(); return trouble }
    fun close() {
        if (closing) return
        closing = true
        try { writer.close(); sink.close() } catch (error: SourceMapIoFailure) { trouble = true }
        closed = true
    }
}

/** Same unclosed byte-buffer capture used by upstream debugToString, with real UTF8 encoding. */
fun captureSourceMapDebug(action: (SourceMapPrintOutput) -> Unit): String {
    val store = SourceMapTextStore(emptyMap())
    val file = store.file("debug")
    action(SourceMapPrintOutput(file.openOverwriteSink()))
    return file.readBytes().compilerUtf8String()
}
