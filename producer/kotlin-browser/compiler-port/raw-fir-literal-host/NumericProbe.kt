package org.jetbrains.kotlin.portable.rawfir.probe

import org.jetbrains.kotlin.portable.rawfir.*
import org.jetbrains.kotlin.fir.lightTree.converter.unquoteParserIdentifier

fun numericObservations(): String = buildString {
    var index = 0
    fun record(name: String, value: Any?) { append(index++).append('|').append(name).append('|').append(value).append('\n') }
    fun number(number: Number?): String = when (number) {
        null -> "null"
        is Long -> "L:" + number
        is Float -> "F:" + number.toRawBits()
        is Double -> "D:" + number.toRawBits()
        else -> error("unexpected numeric class")
    }
    val integers = mutableListOf("0", "1", "-1", "+1", "01", "00", "0_1", "0_0", "0x", "0b", "", "l", "ul", "0_", "_0", "0x_0", "0b_1")
    integers += listOf("2147483647", "2147483648", "4294967295", "4294967296", "9223372036854775807", "9223372036854775808",
        "18446744073709551615", "18446744073709551616", "-9223372036854775808", "-9223372036854775809",
        "0x7fffffffffffffff", "0x8000000000000000", "0xffffffffffffffff", "0x10000000000000000", "0B1111111111111111", "0Xabcdef")
    for (value in 0..80) integers += listOf(value.toString(), value.toString(16).let { "0x" + it }, value.toString(2).let { "0b" + it }, "${value}_0")
    for (text in integers) for (suffix in listOf("", "L", "l", "u", "U", "ul", "uL", "Ul", "UL")) {
        val literal = text + suffix
        record("integer-text", literal)
        record("integer-value", number(parseNumericLiteral(literal, false)))
        record("integer-underscore", hasIllegallyPositionedUnderscore(literal, false))
        record("long-suffix", hasLongSuffix(literal))
        record("unsigned-suffix", hasUnsignedSuffix(literal))
        record("unsigned-long-suffix", hasUnsignedLongSuffix(literal))
    }
    val floating = listOf("0.0", "-0.0", "+0.0", "1.0", "-1.0", ".5", "1.", "1e0", "1E+3", "1e-3", "1_000.25", "1.0_0",
        "1_0e1_0", "1e+", "1e-", "1e", "1._0", "_1.0", "1.0_", "1_e3", "1e_3", "", ".", "e1", "1.2.3", "1e309", "-1e309", "1e-4000",
        "1.7976931348623157e308", "1.7976931348623158e308", "1.7976931348623159e308", "2.2250738585072014e-308", "2.225073858507201e-308",
        "4.9406564584124654e-324", "2.4703282292062327e-324", "2.4703282292062328e-324", "3.4028234663852886e38", "3.4028235677973366e38",
        "1.1754943508222875e-38", "1.401298464324817e-45", "7.006492321624085e-46", "7.006492321624086e-46",
        "1.000000059604644775390625", "1.000000059604644775390626", "1.000000059604644775390624", "16777217.0", "16777219.0")
    for (text in floating) for (suffix in listOf("", "f", "F")) {
        val literal = text + suffix
        record("floating-text", literal)
        record("floating-value", number(parseNumericLiteral(literal, true)))
        record("floating-underscore", hasIllegallyPositionedUnderscore(literal, true))
    }
    for (text in listOf("true", "false", "True", "False", "TRUE", "", " true", "false ", "1", "0")) {
        try { record("boolean", parseBoolean(text)) }
        catch (error: IllegalStateException) { record("boolean-error", error.message) }
    }
    for (text in listOf("simple", "", "`", "``", "`name`", "name`", "`name", "x`y", "`x`y`", "`space value`", "`한글`", "`\uD83D\uDE00`")) {
        val value = unquoteParserIdentifier(text)
        record("identifier-value", value)
        record("identifier-same-reference", value === text)
    }
}
