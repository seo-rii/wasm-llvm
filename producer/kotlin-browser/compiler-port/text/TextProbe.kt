package org.jetbrains.kotlin.portable.text.probe

fun textUnits(text: String): String = buildString {
    for (character in text) append(character.code.toString(16).padStart(4, '0'))
}
private fun byteHex(bytes: ByteArray): String = bytes.joinToString("") { it.toUByte().toString(16).padStart(2, '0') }
private fun bytes(vararg values: Int): ByteArray = ByteArray(values.size) { values[it].toByte() }
private fun quoted(text: String): String = buildString {
    append('"')
    for (character in text) when (character) {
        '\\' -> append("\\\\")
        '"' -> append("\\\"")
        else -> append(character)
    }
    append('"')
}
private fun boundsResult(body: () -> Any?): String = try {
    "ok:" + body()
} catch (failure: Throwable) {
    val kind = when (failure) {
        is IndexOutOfBoundsException -> "IndexOutOfBoundsException"
        is IllegalArgumentException -> "IllegalArgumentException"
        else -> throw failure
    }
    kind + ":" + failure.message
}

fun compilerTextProbe(): String {
    val observations = StringBuilder(); var count = 0
    val groups = mutableMapOf<String, Int>()
    fun observe(group: String, id: String, value: String) {
        if (count++ > 0) observations.append(',')
        groups[group] = (groups[group] ?: 0) + 1
        observations.append('[').append(quoted(group + ":" + id)).append(',').append(quoted(value)).append(']')
    }
    val named = listOf(
        "" to "empty", "ASCII" to "ascii", "한글 컴파일러" to "korean", "\uD83D\uDE00\uD800\uDC00\uDBFF\uDFFF" to "supplementary",
        "\u0000\t\n\r\"'\\" to "wat-escapes", "\uFEFF가\r\n나" to "bom-crlf", "\uD800" to "high", "\uDFFF" to "low",
        "\uDC00\uD800" to "reversed", "\uD800\uD801\uDC00\uDC01" to "mixed-surrogates", "x\uD800가\uDFFFy" to "embedded-malformed",
        "e\u0301é" to "normalization-preserved",
    )
    for ([text, id] in named) observe("writer", id, byteHex(probeEncode(text)) + ";" + byteHex(officialBinaryString(text)) + ";" + textUnits(officialWatString(text)))
    for (size in listOf(0, 1, 127, 128, 129, 16383, 16384, 16385)) {
        val text = "x".repeat(size)
        observe("writer-length", "$size", byteHex(officialBinaryString(text)))
    }
    for (value in 0..0xFFFF) {
        val text = value.toChar().toString()
        observe("utf16-unit", value.toString(16), byteHex(probeEncode(text)))
    }
    for (high in listOf(0xD800, 0xD801, 0xDBFE, 0xDBFF)) for (low in 0xDC00..0xDFFF) {
        val text = high.toChar().toString() + low.toChar()
        observe("utf16-pair", "$high-$low", byteHex(probeEncode(text)))
    }
    for (first in 0..255) {
        val one = bytes(first)
        observe("utf8-one", "$first", textUnits(probeDecode(one)) + ";" + probeStrictDecode(one))
        for (second in 0..255) {
            val two = bytes(first, second)
            observe("utf8-two", "$first-$second", textUnits(probeDecode(two)) + ";" + probeStrictDecode(two))
        }
    }
    val boundary = listOf(0, 0x7F, 0x80, 0x8F, 0x90, 0x9F, 0xA0, 0xBF, 0xC0, 0xDF, 0xF4, 0xFF)
    for (first in 0xE0..0xEF) for (second in boundary) for (third in boundary) {
        val sequence = bytes(first, second, third)
        observe("utf8-three", "$first-$second-$third", textUnits(probeDecode(sequence)) + ";" + probeStrictDecode(sequence))
    }
    for (first in 0xF0..0xF5) for (second in boundary) for (third in boundary) for (fourth in boundary) {
        val sequence = bytes(first, second, third, fourth)
        observe("utf8-four", "$first-$second-$third-$fourth", textUnits(probeDecode(sequence)) + ";" + probeStrictDecode(sequence))
    }
    val source = "A\uD83D\uDE00한\uD800B\uDC00"
    for (start in 0..source.length) for (end in start..source.length) {
        observe("encode-slice", "$start-$end", byteHex(probeEncodeRange(source, start, end)))
    }
    val encoded = bytes(0x41, 0xF0, 0x9F, 0x98, 0x80, 0xED, 0xA0, 0x80, 0xE3, 0x81, 0x82, 0xFF, 0x42)
    for (start in 0..encoded.size) for (end in start..encoded.size) {
        observe("decode-slice", "$start-$end", textUnits(probeDecode(encoded, start, end)) + ";" + probeStrictDecode(encoded, start, end))
    }
    for ([start, end] in listOf(-1 to 0, 0 to 99, 2 to 1, 1 to -1, -1 to 99)) {
        observe("bounds", "encode-$start-$end", boundsResult { byteHex(probeEncodeRange(source, start, end)) })
        observe("bounds", "decode-$start-$end", boundsResult { textUnits(probeDecode(encoded, start, end)) })
    }
    for ([text, id] in named) {
        val locations = StringBuilderWithLocations()
        var step = 0
        for (part in listOf("prefix", text, "\n", text + "\r\n")) {
            locations.append(part)
            observe("locations", "$id-${step++}", "${locations.lineNumber}:${locations.columnNumber}:" + textUnits(locations.toString()))
        }
    }
    val charLocations = StringBuilderWithLocations()
    for (value in listOf(0x41, 0xD83D, 0xDE00, 0xD800, 0x0A, 0xD55C, 0x0D, 0x0A)) {
        charLocations.append(value.toChar())
        observe("locations-char", "${charLocations.toString().length}", "${charLocations.lineNumber}:${charLocations.columnNumber}:" + textUnits(charLocations.toString()))
    }
    return "{\"required\":$count,\"groups\":{${groups.entries.joinToString(",") { quoted(it.key) + ":" + it.value }}},\"cases\":[$observations]}"
}
