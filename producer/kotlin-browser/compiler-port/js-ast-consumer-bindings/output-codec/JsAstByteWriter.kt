/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.portable

/** Byte-array operations required by the selected JS AST DataWriter. */
class JsAstByteWriter {
    private var storage = ByteArray(32)
    private var size = 0

    private fun reserve(additional: Int) {
        require(additional >= 0 && additional <= Int.MAX_VALUE - size) { "JS AST output length exceeds Int range" }
        val required = size + additional
        if (required <= storage.size) return
        val doubled = if (storage.size <= Int.MAX_VALUE / 2) storage.size * 2 else Int.MAX_VALUE
        storage = storage.copyOf(maxOf(required, doubled))
    }

    fun writeByte(value: Int) {
        reserve(1)
        storage[size++] = value.toByte()
    }

    fun writeBoolean(value: Boolean) = writeByte(if (value) 1 else 0)

    fun writeInt(value: Int) {
        reserve(4)
        for (shift in 24 downTo 0 step 8) storage[size++] = (value ushr shift).toByte()
    }

    fun writeDouble(value: Double) {
        reserve(8)
        // DataOutputStream uses doubleToLongBits, including canonical NaNs.
        val bits = value.toBits()
        for (shift in 56 downTo 0 step 8) storage[size++] = (bits ushr shift).toByte()
    }

    fun write(bytes: ByteArray) {
        reserve(bytes.size)
        bytes.copyInto(storage, size)
        size += bytes.size
    }

    fun toByteArray(): ByteArray = storage.copyOf(size)

    fun writeTo(destination: JsAstByteWriter) {
        destination.reserve(size)
        // Capture the source length before self-transfer changes it.
        val length = size
        storage.copyInto(destination.storage, destination.size, 0, length)
        destination.size += length
    }
}
