/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.util

/** Signed arbitrary magnitude required by real JS bigint literals and their byte serialization. */
class AstInteger private constructor(private val sign: Int, private val magnitude: IntArray) : Comparable<AstInteger> {
    private constructor(parts: Pair<Int, IntArray>) : this(parts.first, parts.second)
    constructor(bytes: ByteArray) : this(decode(bytes))

    override fun compareTo(other: AstInteger): Int {
        if (sign != other.sign) return sign.compareTo(other.sign)
        if (sign == 0) return 0
        if (magnitude.size != other.magnitude.size) return sign * magnitude.size.compareTo(other.magnitude.size)
        for (i in magnitude.lastIndex downTo 0) {
            if (magnitude[i] != other.magnitude[i]) return sign * magnitude[i].compareTo(other.magnitude[i])
        }
        return 0
    }

    fun toByteArray(): ByteArray {
        if (sign == 0) return byteArrayOf(0)
        val bytes = ByteArray(magnitude.size) { magnitude[magnitude.lastIndex - it].toByte() }
        if (sign > 0) return if (bytes[0] < 0) byteArrayOf(0) + bytes else bytes
        var carry = 1
        for (i in bytes.lastIndex downTo 0) {
            val value = ((bytes[i].toInt() and 255) xor 255) + carry
            bytes[i] = value.toByte()
            carry = value ushr 8
        }
        return if (bytes[0] >= 0) byteArrayOf(-1) + bytes else bytes
    }

    override fun toString(): String {
        if (sign == 0) return "0"
        val work = magnitude.copyOf()
        var used = work.size
        val digits = StringBuilder()
        while (used != 0) {
            var carry = 0
            for (i in used - 1 downTo 0) {
                val value = carry * 256 + work[i]
                work[i] = value / 10
                carry = value % 10
            }
            digits.append(('0'.code + carry).toChar())
            while (used > 0 && work[used - 1] == 0) used--
        }
        if (sign < 0) digits.append('-')
        return digits.reverse().toString()
    }

    override fun equals(other: Any?): Boolean = other is AstInteger && sign == other.sign && magnitude.contentEquals(other.magnitude)
    override fun hashCode(): Int {
        var hash = 0
        for (word in (magnitude.size + 3) / 4 - 1 downTo 0) {
            var value = 0L
            for (byte in 3 downTo 0) {
                val index = word * 4 + byte
                value = (value shl 8) or (if (index < magnitude.size) magnitude[index].toLong() else 0L)
            }
            hash = 31 * hash + value.toInt()
        }
        return sign * hash
    }

    companion object {
        val ZERO: AstInteger = AstInteger(0, IntArray(0))
        fun valueOf(value: Long): AstInteger = AstInteger(ByteArray(8) { (value ushr ((7 - it) * 8)).toByte() })
        private fun decode(bytes: ByteArray): Pair<Int, IntArray> {
            if (bytes.isEmpty()) throw NumberFormatException("Zero length BigInteger")
            val negative = bytes[0] < 0
            val magnitude = IntArray(bytes.size) { bytes[bytes.lastIndex - it].toInt() and 255 }
            if (negative) {
                var carry = 1
                for (i in magnitude.indices) {
                    val value = (magnitude[i] xor 255) + carry
                    magnitude[i] = value and 255
                    carry = value ushr 8
                }
            }
            var used = magnitude.size
            while (used > 0 && magnitude[used - 1] == 0) used--
            return (if (used == 0) 0 else if (negative) -1 else 1) to magnitude.copyOf(used)
        }
    }
}
