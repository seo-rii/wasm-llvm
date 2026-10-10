package org.jetbrains.kotlin.js.util.numbers.probe

expect fun renderedDouble(value: Double): String

/** Raw bit identities and unmodified text; every exponent and both signs are included. */
fun observeDoubleTexts(): String = buildString {
    fun emit(value: Double) {
        append(value.toRawBits().toULong().toString(16)).append(':').append(renderedDouble(value)).append('\n')
    }
    val boundaries = listOf(0.0, -0.0, Double.MIN_VALUE, Double.MAX_VALUE, Double.NaN, Double.POSITIVE_INFINITY,
        Double.NEGATIVE_INFINITY, 1e-324, 1e-323, 1e-308, 1e-3, 1e-4, 1e6, 1e7, 1e23, 1e-23, 1.2345678901234567,
        0.1, 0.5, 0.25, 1.0, 2.0, 1e308, 1e-307, 9007199254740991.0, 9007199254740992.0,
        2147483647.0, 2147483648.0, 9223372036854775808.0)
    for (value in boundaries) for (sign in listOf(value, -value)) {
        emit(sign)
        val bits = sign.toRawBits()
        for (delta in -3L..3L) emit(Double.fromBits(bits + delta))
    }
    for (exponent in 0..2047) for (mantissa in listOf(0L, 1L, 0x0007ffffffffffffL, 0x000fffffffffffffL)) {
        val bits = (exponent.toLong() shl 52) or mantissa
        emit(Double.fromBits(bits))
        emit(Double.fromBits(bits or Long.MIN_VALUE))
    }
    var bits = 0x0123456789abcdefL
    repeat(100000) {
        bits = bits * 6364136223846793005L + 1442695040888963407L
        emit(Double.fromBits(bits))
    }
}
