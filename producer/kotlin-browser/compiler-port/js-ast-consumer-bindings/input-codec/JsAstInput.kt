/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.portable

import org.jetbrains.kotlin.portable.text.compilerUtf8String

/** Selected JS AST input operations over the original, caller-owned byte array. */
class JsAstInput(private val source: ByteArray) {
    var position: Int = 0
        private set

    private fun need(count: Int) {
        if (source.size - position < count) throw JsAstInputUnderflow()
    }

    fun readByte(): Byte {
        need(1)
        return source[position++]
    }

    fun readInt(): Int {
        need(4)
        var value = 0
        repeat(4) { value = (value shl 8) or (source[position++].toInt() and 255) }
        return value
    }

    fun readDouble(): Double {
        need(8)
        var bits = 0L
        repeat(8) { bits = (bits shl 8) or (source[position++].toLong() and 255L) }
        return Double.fromBits(bits)
    }

    fun seek(offset: Int) {
        require(offset >= 0 && offset <= source.size) { "Invalid JS AST input position" }
        position = offset
    }

    fun readUtf8(offset: Int, length: Int): String {
        require(length >= 0 && offset >= 0 && offset <= source.size && length <= source.size - offset) { "Invalid JS AST byte length" }
        return source.compilerUtf8String(offset, offset + length)
    }
}

/** Atomic read exhaustion; Java exception class identity is not emulated. */
class JsAstInputUnderflow : RuntimeException()
