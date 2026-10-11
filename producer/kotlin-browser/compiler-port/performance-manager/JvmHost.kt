/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.util.portable.probe

import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import org.jetbrains.kotlin.util.portable.*

private val hostEvents = mutableListOf<Pair<String, String>>()
internal fun hostFormat(pattern: String, english: Boolean, args: Array<out Any?>): String {
    val result = if (english) String.format(Locale.ENGLISH, pattern, *args) else String.format(pattern, *args)
    hostEvents.add("format:" + oracleKey(pattern, english, args) to result)
    return result
}
internal fun hostDateFormatter(kind: PerformanceDateFormat): PerformanceDateFormatter {
    hostEvents.add("date:create:$kind" to "")
    val formatter = when (kind) {
        PerformanceDateFormat.FileName -> SimpleDateFormat("yyyy-MM-dd-HH-mm-ss")
        PerformanceDateFormat.Markdown -> SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.ENGLISH).also { it.timeZone = TimeZone.getTimeZone("UTC") }
    }
    return PerformanceDateFormatter { stamp -> formatter.format(stamp).also { hostEvents.add("date:$kind:$stamp" to it) } }
}
internal fun hostOracleSource(): String {
    fun quoted(value: String) = buildString {
        append('"')
        for (char in value) when (char) {
            '\\' -> append("\\\\")
            '"' -> append("\\\"")
            '$' -> append("\\$")
            else -> if (char.code < 32 || char in '\uD800'..'\uDFFF') append("\\u%04x".format(char.code)) else append(char)
        }
        append('"')
    }
    return "package org.jetbrains.kotlin.util.portable.probe\ninternal val oracleEvents = listOf(\n" +
            hostEvents.joinToString(",\n") { [key, value] -> "    " + quoted(key) + " to " + quoted(value) } + "\n)\n"
}
