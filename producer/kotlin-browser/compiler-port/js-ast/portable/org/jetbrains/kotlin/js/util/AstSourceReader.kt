/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.util

/** UTF-16 source character reader. Source providers own their reader and its close lifecycle. */
abstract class AstSourceReader {
    abstract fun read(buffer: CharArray, offset: Int, length: Int): Int
    open fun read(): Int {
        val buffer = CharArray(1)
        return if (read(buffer, 0, 1) == -1) -1 else buffer[0].code
    }
    abstract fun close()
    fun readText(): String = buildString {
        val buffer = CharArray(1024)
        while (true) {
            val count = read(buffer, 0, buffer.size)
            if (count == -1) break
            if (count > 0) appendRange(buffer, 0, count)
        }
    }
}

class AstStringReader(private val text: String) : AstSourceReader() {
    private var position = 0
    private var closed = false
    override fun read(buffer: CharArray, offset: Int, length: Int): Int {
        if (closed) throw AstReaderClosedException("Stream closed")
        if (offset < 0 || length < 0 || offset > buffer.size - length) throw IndexOutOfBoundsException()
        if (length == 0) return 0
        if (position == text.length) return -1
        val count = minOf(length, text.length - position)
        for (i in 0 until count) buffer[offset + i] = text[position + i]
        position += count
        return count
    }
    override fun close() { closed = true }
}

/** Same stream-closed failure category as the source reader boundary; no JVM IOException FQCN claim. */
class AstReaderClosedException(message: String) : Exception(message)
