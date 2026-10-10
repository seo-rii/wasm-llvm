/*
 * Copyright (c) 1996, 2016, Oracle and/or its affiliates. All rights reserved.
 * DO NOT ALTER OR REMOVE COPYRIGHT NOTICES OR THIS FILE HEADER.
 *
 * This code is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License version 2 only, as
 * published by the Free Software Foundation.  Oracle designates this
 * particular file as subject to the "Classpath" exception as provided
 * by Oracle in the LICENSE file that accompanied this code.
 *
 * This code is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
 * version 2 for more details (a copy is included in the LICENSE file that
 * accompanied this code).
 *
 * You should have received a copy of the GNU General Public License version
 * 2 along with this work; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin St, Fifth Floor, Boston, MA 02110-1301 USA.
 *
 * Please contact Oracle, 500 Oracle Parkway, Redwood Shores, CA 94065 USA
 * or visit www.oracle.com if you need additional information or have any
 * questions.
 */
/*
 * FDBigInteger source copyright: Copyright (c) 2013, 2020, Oracle and/or its affiliates.
 * All rights reserved. Same GPL-2.0-only WITH Classpath-exception-2.0 license.
 * Modified 2026-10-10 by wasm-llvm contributors: common Kotlin binary64-to-Java-text
 * conversion from the pinned OpenJDK 17 FloatingDecimal. The positive integer
 * operations used by its big-number branch use immutable base-2^30 limbs instead
 * of the full JVM FDBigInteger API. See js-ast/numbers/LICENSE.OpenJDK and source.lock.json.
 */
package org.jetbrains.kotlin.js.util

/** Exact JDK 17 Double.toString spelling; independent of the host's Double.toString. */
fun javaDoubleToString(value: Double): String {
    val bits = value.toRawBits()
    val negative = bits < 0
    var fraction = bits and 0x000fffffffffffffL
    var exponent = ((bits ushr 52) and 0x7ff).toInt()
    if (exponent == 0x7ff) return if (fraction != 0L) "NaN" else if (negative) "-Infinity" else "Infinity"
    val significantBits: Int
    if (exponent == 0) {
        if (fraction == 0L) return if (negative) "-0.0" else "0.0"
        val leadingZeros = fraction.countLeadingZeroBits()
        val shift = leadingZeros - 11
        fraction = fraction shl shift
        exponent = 1 - shift
        significantBits = 64 - leadingZeros
    } else {
        fraction = fraction or (1L shl 52)
        significantBits = 53
    }
    return JavaBinary64Digits(negative).convert(exponent - 1023, fraction, significantBits)
}

private val javaLongFivePowers = LongArray(27).also { powers ->
    powers[0] = 1
    for (i in 1..<powers.size) powers[i] = powers[i - 1] * 5
}
private val javaSmallFivePowers = IntArray(14) { javaLongFivePowers[it].toInt() }
private val javaFivePowerBits = intArrayOf(0, 3, 5, 7, 10, 12, 14, 17, 19, 21, 24, 26, 28, 31, 33, 35, 38, 40, 42, 45, 47, 49, 52, 54, 56, 59, 61)
private val javaInsignificantDigits = intArrayOf(
    0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 3,
    4, 4, 4, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7,
    8, 8, 8, 9, 9, 9, 9, 10, 10, 10, 11, 11, 11,
    12, 12, 12, 12, 13, 13, 13, 14, 14, 14,
    15, 15, 15, 15, 16, 16, 16, 17, 17, 17,
    18, 18, 18, 19,
)

private class JavaBinary64Digits(private val negative: Boolean) {
    private val digits = CharArray(20)
    private var decimalExponent = 0
    private var firstDigit = 0
    private var digitCount = 0

    fun convert(binaryExponent: Int, fraction: Long, significantBits: Int): String {
        dtoa(binaryExponent, fraction, significantBits)
        return javaText()
    }

    private fun developLongDigits(exponent: Int, input: Long, insignificantDigits: Int) {
        var decExponent = exponent
        var value = input
        if (insignificantDigits != 0) {
            val power = javaLongFivePowers[insignificantDigits] shl insignificantDigits
            val residue = value % power
            value /= power
            decExponent += insignificantDigits
            if (residue >= (power shr 1)) value++
        }
        var digit = digits.lastIndex
        var c: Int
        if (value <= Int.MAX_VALUE) {
            var intValue = value.toInt()
            c = intValue % 10
            intValue /= 10
            while (c == 0) {
                decExponent++
                c = intValue % 10
                intValue /= 10
            }
            while (intValue != 0) {
                digits[digit--] = '0' + c
                decExponent++
                c = intValue % 10
                intValue /= 10
            }
        } else {
            c = (value % 10).toInt()
            value /= 10
            while (c == 0) {
                decExponent++
                c = (value % 10).toInt()
                value /= 10
            }
            while (value != 0L) {
                digits[digit--] = '0' + c
                decExponent++
                c = (value % 10).toInt()
                value /= 10
            }
        }
        digits[digit] = '0' + c
        decimalExponent = decExponent + 1
        firstDigit = digit
        digitCount = digits.size - digit
    }

    private fun dtoa(binExp: Int, inputFraction: Long, significantBits: Int) {
        var fraction = inputFraction
        val trailingZeros = fraction.countTrailingZeroBits()
        val fractionBits = 53 - trailingZeros
        val tinyBits = maxOf(0, fractionBits - binExp - 1)
        if (binExp in -21..62 && tinyBits < javaLongFivePowers.size && fractionBits + javaFivePowerBits[tinyBits] < 64) {
            if (tinyBits == 0) {
                val power = binExp - significantBits - 1
                val insignificant = if (binExp > significantBits && power > 1 && power < javaInsignificantDigits.size) javaInsignificantDigits[power] else 0
                fraction = if (binExp >= 52) fraction shl (binExp - 52) else fraction ushr (52 - binExp)
                developLongDigits(0, fraction, insignificant)
                return
            }
        }
        var decExp = estimateDecimalExponent(fraction, binExp)
        val b5 = maxOf(0, -decExp)
        var b2 = b5 + tinyBits + binExp
        val s5 = maxOf(0, decExp)
        var s2 = s5 + tinyBits
        val m5 = b5
        var m2 = b2 - significantBits
        fraction = fraction ushr trailingZeros
        b2 -= fractionBits - 1
        val commonTwoFactor = minOf(b2, s2)
        b2 -= commonTwoFactor
        s2 -= commonTwoFactor
        m2 -= commonTwoFactor
        if (fractionBits == 1) m2--
        if (m2 < 0) {
            b2 -= m2
            s2 -= m2
            m2 = 0
        }
        val bBits = fractionBits + b2 + if (b5 < javaFivePowerBits.size) javaFivePowerBits[b5] else b5 * 3
        val tenSBits = s2 + 1 + if (s5 + 1 < javaFivePowerBits.size) javaFivePowerBits[s5 + 1] else (s5 + 1) * 3
        var count = 0
        var low: Boolean
        var high: Boolean
        var difference: Long
        var quotient: Int
        if (bBits < 64 && tenSBits < 64) {
            if (bBits < 32 && tenSBits < 32) {
                var b = (fraction.toInt() * javaSmallFivePowers[b5]) shl b2
                val s = javaSmallFivePowers[s5] shl s2
                var m = javaSmallFivePowers[m5] shl m2
                val tenS = s * 10
                quotient = b / s
                b = 10 * (b % s)
                m *= 10
                low = b < m
                high = b + m > tenS
                if (quotient == 0 && !high) decExp-- else digits[count++] = '0' + quotient
                if (decExp < -3 || decExp >= 8) { low = false; high = false }
                while (!low && !high) {
                    quotient = b / s
                    b = 10 * (b % s)
                    m *= 10
                    if (m > 0) { low = b < m; high = b + m > tenS }
                    else { low = true; high = true }
                    digits[count++] = '0' + quotient
                }
                // Preserve Java's Int overflow before widening to Long.
                difference = ((b shl 1) - tenS).toLong()
            } else {
                var b = (fraction * javaLongFivePowers[b5]) shl b2
                val s = javaLongFivePowers[s5] shl s2
                var m = javaLongFivePowers[m5] shl m2
                val tenS = s * 10L
                quotient = (b / s).toInt()
                b = 10L * (b % s)
                m *= 10L
                low = b < m
                high = b + m > tenS
                if (quotient == 0 && !high) decExp-- else digits[count++] = '0' + quotient
                if (decExp < -3 || decExp >= 8) { low = false; high = false }
                while (!low && !high) {
                    quotient = (b / s).toInt()
                    b = 10L * (b % s)
                    m *= 10L
                    if (m > 0) { low = b < m; high = b + m > tenS }
                    else { low = true; high = true }
                    digits[count++] = '0' + quotient
                }
                difference = (b shl 1) - tenS
            }
        } else {
            var s = JavaPositiveInteger.pow52(s5, s2)
            val bias = s.normalizationBias()
            s = s.shiftLeft(bias)
            var b = JavaPositiveInteger.fromLong(fraction).times(JavaPositiveInteger.pow52(b5, b2 + bias))
            var m = JavaPositiveInteger.pow52(m5 + 1, m2 + bias + 1)
            val tenS = JavaPositiveInteger.pow52(s5 + 1, s2 + bias + 1)
            var division = b.quotientRemainderIteration(s)
            quotient = division.first
            b = division.second
            low = b.compareTo(m) < 0
            // FDBigInteger addAndCmp is inclusive here, unlike the Int/Long branches.
            high = tenS.compareTo(b.plus(m)) <= 0
            if (quotient == 0 && !high) decExp-- else digits[count++] = '0' + quotient
            if (decExp < -3 || decExp >= 8) { low = false; high = false }
            while (!low && !high) {
                division = b.quotientRemainderIteration(s)
                quotient = division.first
                b = division.second
                m = m.timesSmall(10)
                low = b.compareTo(m) < 0
                high = tenS.compareTo(b.plus(m)) <= 0
                digits[count++] = '0' + quotient
            }
            difference = if (high && low) b.shiftLeft(1).compareTo(tenS).toLong() else 0L
        }
        decimalExponent = decExp + 1
        firstDigit = 0
        digitCount = count
        if (high) {
            if (low) {
                if (difference == 0L) {
                    if ((digits[firstDigit + digitCount - 1].code and 1) != 0) roundUp()
                } else if (difference > 0) roundUp()
            } else roundUp()
        }
    }

    private fun roundUp() {
        var index = firstDigit + digitCount - 1
        var digit = digits[index]
        if (digit == '9') {
            while (digit == '9' && index > firstDigit) {
                digits[index] = '0'
                digit = digits[--index]
            }
            if (digit == '9') {
                decimalExponent++
                digits[firstDigit] = '1'
                return
            }
        }
        digits[index] = digit + 1
    }

    private fun javaText(): String = buildString {
        if (negative) append('-')
        if (decimalExponent > 0 && decimalExponent < 8) {
            val length = minOf(digitCount, decimalExponent)
            append(digits.concatToString(firstDigit, firstDigit + length))
            if (length < decimalExponent) {
                repeat(decimalExponent - length) { append('0') }
                append(".0")
            } else {
                append('.')
                if (length < digitCount) append(digits.concatToString(firstDigit + length, firstDigit + digitCount)) else append('0')
            }
        } else if (decimalExponent <= 0 && decimalExponent > -3) {
            append("0.")
            repeat(-decimalExponent) { append('0') }
            append(digits.concatToString(firstDigit, firstDigit + digitCount))
        } else {
            append(digits[firstDigit]).append('.')
            if (digitCount > 1) append(digits.concatToString(firstDigit + 1, firstDigit + digitCount)) else append('0')
            append('E')
            append(decimalExponent - 1)
        }
    }

    private fun estimateDecimalExponent(fraction: Long, binaryExponent: Int): Int {
        val d2 = Double.fromBits((1023L shl 52) or (fraction and 0x000fffffffffffffL))
        val d = (d2 - 1.5) * 0.289529654 + 0.176091259 + binaryExponent.toDouble() * 0.301029995663981
        val bits = d.toRawBits()
        val exponent = ((bits ushr 52) and 0x7ff).toInt() - 1023
        val negative = bits < 0
        if (exponent >= 0 && exponent < 52) {
            val mask = 0x000fffffffffffffL shr exponent
            val integral = (((bits and 0x000fffffffffffffL) or (1L shl 52)) shr (52 - exponent)).toInt()
            return if (negative) if ((mask and bits) == 0L) -integral else -integral - 1 else integral
        }
        if (exponent < 0) return if ((bits and Long.MAX_VALUE) == 0L) 0 else if (negative) -1 else 0
        return d.toInt()
    }
}

/** Exact nonnegative arithmetic required by the pinned FDBigInteger conversion contracts.
 * Limbs are 30 bits, so every product plus carry fits a signed Long on JVM and Wasm.
 * No input-dependent fallback to a host formatter or floating integer approximation exists. */
private class JavaPositiveInteger private constructor(private val limbs: IntArray) {
    fun compareTo(other: JavaPositiveInteger): Int {
        if (limbs.size != other.limbs.size) return limbs.size.compareTo(other.limbs.size)
        for (i in limbs.indices.reversed()) if (limbs[i] != other.limbs[i]) return limbs[i].compareTo(other.limbs[i])
        return 0
    }
    fun normalizationBias(): Int {
        if (limbs.isEmpty()) throw IllegalArgumentException("Zero value cannot be normalized")
        val bitLength = (limbs.size - 1) * 30 + 32 - limbs.last().countLeadingZeroBits()
        val highWordBits = (bitLength - 1) % 32 + 1
        val zeros = 32 - highWordBits
        return if (zeros < 4) 28 + zeros else zeros - 4
    }
    fun shiftLeft(bits: Int): JavaPositiveInteger {
        require(bits >= 0)
        if (limbs.isEmpty() || bits == 0) return this
        val words = bits / 30
        val shift = bits % 30
        val result = IntArray(limbs.size + words + 1)
        var carry = 0L
        for (i in limbs.indices) {
            val value = (limbs[i].toLong() shl shift) or carry
            result[i + words] = (value and MASK).toInt()
            carry = value ushr 30
        }
        result[limbs.size + words] = carry.toInt()
        return normalized(result)
    }
    fun timesSmall(factor: Int): JavaPositiveInteger {
        require(factor >= 0)
        val result = IntArray(limbs.size + 1)
        var carry = 0L
        for (i in limbs.indices) {
            val value = limbs[i].toLong() * factor + carry
            result[i] = (value and MASK).toInt()
            carry = value ushr 30
        }
        result[limbs.size] = carry.toInt()
        return normalized(result)
    }
    fun times(other: JavaPositiveInteger): JavaPositiveInteger {
        val result = IntArray(limbs.size + other.limbs.size)
        for (i in limbs.indices) {
            var carry = 0L
            for (j in other.limbs.indices) {
                val value = limbs[i].toLong() * other.limbs[j] + result[i + j] + carry
                result[i + j] = (value and MASK).toInt()
                carry = value ushr 30
            }
            if (other.limbs.isNotEmpty()) result[i + other.limbs.size] = carry.toInt()
        }
        return normalized(result)
    }
    fun plus(other: JavaPositiveInteger): JavaPositiveInteger {
        val result = IntArray(maxOf(limbs.size, other.limbs.size) + 1)
        var carry = 0L
        for (i in 0..<result.lastIndex) {
            val value = (if (i < limbs.size) limbs[i].toLong() else 0L) + (if (i < other.limbs.size) other.limbs[i].toLong() else 0L) + carry
            result[i] = (value and MASK).toInt()
            carry = value ushr 30
        }
        result[result.lastIndex] = carry.toInt()
        return normalized(result)
    }
    private fun minus(other: JavaPositiveInteger): JavaPositiveInteger {
        val result = IntArray(limbs.size)
        var borrow = 0L
        for (i in limbs.indices) {
            var value = limbs[i].toLong() - (if (i < other.limbs.size) other.limbs[i].toLong() else 0L) - borrow
            borrow = if (value < 0) 1L else 0L
            if (value < 0) value += BASE
            result[i] = value.toInt()
        }
        check(borrow == 0L)
        return normalized(result)
    }
    /** Returns floor(B/S) and 10*(B mod S), with the original decimal-digit bound. */
    fun quotientRemainderIteration(divisor: JavaPositiveInteger): Pair<Int, JavaPositiveInteger> {
        var remainder = this
        var quotient = 0
        while (remainder.compareTo(divisor) >= 0) {
            remainder = remainder.minus(divisor)
            quotient++
        }
        check(quotient < 10)
        return quotient to remainder.timesSmall(10)
    }
    companion object {
        private const val BASE = 1L shl 30
        private const val MASK = BASE - 1
        private val fivePowers: Array<JavaPositiveInteger> = run {
            var value = fromLong(1)
            Array(326) { exponent -> if (exponent != 0) value = value.timesSmall(5); value }
        }
        private fun normalized(words: IntArray): JavaPositiveInteger {
            var size = words.size
            while (size > 0 && words[size - 1] == 0) size--
            return JavaPositiveInteger(if (size == words.size) words else words.copyOf(size))
        }
        fun fromLong(value: Long): JavaPositiveInteger {
            require(value >= 0)
            val words = intArrayOf((value and MASK).toInt(), ((value ushr 30) and MASK).toInt(), (value ushr 60).toInt())
            return normalized(words)
        }
        fun pow52(fives: Int, twos: Int): JavaPositiveInteger {
            require(fives in fivePowers.indices)
            return fivePowers[fives].shiftLeft(twos)
        }
    }
}
