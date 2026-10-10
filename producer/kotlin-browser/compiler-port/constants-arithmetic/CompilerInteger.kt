/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.portable.constants

import org.jetbrains.kotlin.js.util.AstInteger

/** Immutable arithmetic over unbounded signed magnitudes, canonicalized by the pinned AST integer. */
class CompilerInteger private constructor(private val value: AstInteger) : Comparable<CompilerInteger> {
    constructor(bytes: ByteArray) : this(AstInteger(bytes))

    private val sign = value.compareTo(AstInteger.ZERO)
    private val magnitude = magnitudeOf(value.toByteArray(), sign)

    fun add(other: CompilerInteger): CompilerInteger {
        if (sign == 0) return other
        if (other.sign == 0) return this
        if (sign == other.sign) return fromMagnitude(sign, addMagnitude(magnitude, other.magnitude))
        val comparison = compareMagnitude(magnitude, other.magnitude)
        return when {
            comparison == 0 -> ZERO
            comparison > 0 -> fromMagnitude(sign, subtractMagnitude(magnitude, other.magnitude))
            else -> fromMagnitude(other.sign, subtractMagnitude(other.magnitude, magnitude))
        }
    }

    fun subtract(other: CompilerInteger): CompilerInteger {
        if (other.sign == 0) return this
        if (sign == 0) return fromMagnitude(-other.sign, other.magnitude)
        if (sign != other.sign) return fromMagnitude(sign, addMagnitude(magnitude, other.magnitude))
        val comparison = compareMagnitude(magnitude, other.magnitude)
        return when {
            comparison == 0 -> ZERO
            comparison > 0 -> fromMagnitude(sign, subtractMagnitude(magnitude, other.magnitude))
            else -> fromMagnitude(-sign, subtractMagnitude(other.magnitude, magnitude))
        }
    }

    fun multiply(other: CompilerInteger): CompilerInteger {
        if (sign == 0 || other.sign == 0) return ZERO
        val product = digits(magnitude.size.toLong() + other.magnitude.size)
        for (i in magnitude.indices) {
            var carry = 0
            for (j in other.magnitude.indices) {
                val index = i + j
                val total = product[index] + magnitude[i] * other.magnitude[j] + carry
                product[index] = total and 255
                carry = total ushr 8
            }
            var index = i + other.magnitude.size
            while (carry != 0) {
                val total = product[index] + carry
                product[index++] = total and 255
                carry = total ushr 8
            }
        }
        return fromMagnitude(sign * other.sign, trim(product))
    }

    fun divide(other: CompilerInteger): CompilerInteger = quotientAndRemainder(other).first
    operator fun rem(other: CompilerInteger): CompilerInteger = quotientAndRemainder(other).second

    private fun quotientAndRemainder(other: CompilerInteger): Pair<CompilerInteger, CompilerInteger> {
        if (other.sign == 0) throw ArithmeticException("BigInteger divide by zero")
        if (sign == 0) return ZERO to ZERO
        val result = divideMagnitude(magnitude, other.magnitude)
        return fromMagnitude(sign * other.sign, result.first) to fromMagnitude(sign, result.second)
    }

    fun and(other: CompilerInteger): CompilerInteger = bitwise(other, 0)
    fun or(other: CompilerInteger): CompilerInteger = bitwise(other, 1)
    fun xor(other: CompilerInteger): CompilerInteger = bitwise(other, 2)

    private fun bitwise(other: CompilerInteger, operation: Int): CompilerInteger {
        val left = value.toByteArray()
        val right = other.value.toByteArray()
        val size = maxOf(left.size, right.size)
        val result = ByteArray(size)
        for (i in 0 until size) {
            val leftIndex = i - (size - left.size)
            val rightIndex = i - (size - right.size)
            val a = if (leftIndex >= 0) left[leftIndex].toInt() else if (sign < 0) -1 else 0
            val b = if (rightIndex >= 0) right[rightIndex].toInt() else if (other.sign < 0) -1 else 0
            result[i] = when (operation) { 0 -> a and b; 1 -> a or b; else -> a xor b }.toByte()
        }
        return CompilerInteger(AstInteger(result))
    }

    override fun compareTo(other: CompilerInteger): Int = value.compareTo(other.value)
    fun toByteArray(): ByteArray = value.toByteArray()
    override fun toString(): String = value.toString()
    override fun equals(other: Any?): Boolean = other is CompilerInteger && value == other.value
    override fun hashCode(): Int = value.hashCode()

    companion object {
        val ZERO = CompilerInteger(AstInteger.ZERO)
        fun valueOf(value: Long): CompilerInteger = if (value == 0L) ZERO else CompilerInteger(AstInteger.valueOf(value))

        private fun digits(size: Long): IntArray {
            if (size > Int.MAX_VALUE) throw ArithmeticException("Compiler integer array size overflow")
            return IntArray(size.toInt())
        }

        private fun trim(digits: IntArray): IntArray {
            var size = digits.size
            while (size > 0 && digits[size - 1] == 0) size--
            return if (size == digits.size) digits else digits.copyOf(size)
        }

        private fun magnitudeOf(bytes: ByteArray, sign: Int): IntArray {
            if (sign == 0) return IntArray(0)
            val result = IntArray(bytes.size) { bytes[bytes.lastIndex - it].toInt() and 255 }
            if (sign < 0) {
                var carry = 1
                for (i in result.indices) {
                    val next = (result[i] xor 255) + carry
                    result[i] = next and 255
                    carry = next ushr 8
                }
            }
            return trim(result)
        }

        private fun fromMagnitude(sign: Int, magnitude: IntArray): CompilerInteger {
            val normalized = trim(magnitude)
            if (normalized.isEmpty()) return ZERO
            var bytes = ByteArray(normalized.size) { normalized[normalized.lastIndex - it].toByte() }
            if (sign < 0) {
                var carry = 1
                for (i in bytes.lastIndex downTo 0) {
                    val next = ((bytes[i].toInt() and 255) xor 255) + carry
                    bytes[i] = next.toByte()
                    carry = next ushr 8
                }
            }
            if ((sign > 0 && bytes[0] < 0) || (sign < 0 && bytes[0] >= 0)) {
                val paddedSize = bytes.size.toLong() + 1
                if (paddedSize > Int.MAX_VALUE) throw ArithmeticException("Compiler integer array size overflow")
                val padded = ByteArray(paddedSize.toInt())
                padded[0] = if (sign < 0) -1 else 0
                bytes.copyInto(padded, 1)
                bytes = padded
            }
            return CompilerInteger(AstInteger(bytes))
        }

        private fun compareMagnitude(left: IntArray, right: IntArray): Int {
            if (left.size != right.size) return left.size.compareTo(right.size)
            for (i in left.lastIndex downTo 0) if (left[i] != right[i]) return left[i].compareTo(right[i])
            return 0
        }

        private fun addMagnitude(left: IntArray, right: IntArray): IntArray {
            val size = maxOf(left.size, right.size)
            val result = digits(size.toLong() + 1)
            var carry = 0
            for (i in 0 until size) {
                val total = (if (i < left.size) left[i] else 0) + (if (i < right.size) right[i] else 0) + carry
                result[i] = total and 255
                carry = total ushr 8
            }
            result[size] = carry
            return trim(result)
        }

        /** Requires left >= right; all arguments are immutable private magnitudes. */
        private fun subtractMagnitude(left: IntArray, right: IntArray): IntArray {
            val result = IntArray(left.size)
            var borrow = 0
            for (i in left.indices) {
                val next = left[i] - (if (i < right.size) right[i] else 0) - borrow
                result[i] = next and 255
                borrow = if (next < 0) 1 else 0
            }
            return trim(result)
        }

        /** Binary long division: nonnegative quotient/remainder, with remainder < divisor. */
        private fun divideMagnitude(left: IntArray, right: IntArray): Pair<IntArray, IntArray> {
            val comparison = compareMagnitude(left, right)
            if (comparison < 0) return IntArray(0) to left
            if (comparison == 0) return intArrayOf(1) to IntArray(0)
            val quotient = IntArray(left.size)
            val remainder = digits(right.size.toLong() + 1)
            var used = 0
            for (byteIndex in left.lastIndex downTo 0) for (bit in 7 downTo 0) {
                var carry = (left[byteIndex] ushr bit) and 1
                for (i in 0 until used) {
                    val next = (remainder[i] shl 1) or carry
                    remainder[i] = next and 255
                    carry = next ushr 8
                }
                if (carry != 0) remainder[used++] = carry
                val greaterOrEqual = if (used != right.size) used > right.size else {
                    var order = 0
                    for (i in used - 1 downTo 0) if (remainder[i] != right[i]) { order = remainder[i].compareTo(right[i]); break }
                    order >= 0
                }
                if (greaterOrEqual) {
                    var borrow = 0
                    for (i in 0 until used) {
                        val next = remainder[i] - (if (i < right.size) right[i] else 0) - borrow
                        remainder[i] = next and 255
                        borrow = if (next < 0) 1 else 0
                    }
                    while (used > 0 && remainder[used - 1] == 0) used--
                    quotient[byteIndex] = quotient[byteIndex] or (1 shl bit)
                }
            }
            return trim(quotient) to remainder.copyOf(used)
        }
    }
}
