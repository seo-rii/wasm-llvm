package org.jetbrains.kotlin.portable.diagnostics.probe

private fun String.units() = buildString { for (character in this@units) append(character.code.toString(16).padStart(4, '0')) }

// Actual platform traces intentionally differ. Preserve and check each raw
// trace, rather than pretending that host-dependent frames are identical.
fun traceObservation(): String = buildString {
    val messages = listOf("", "boom", "한글😀", "x".repeat(2040), "x".repeat(2048), "x".repeat(4096), "\uD800".repeat(2100))
    for (entry in messages.withIndex()) {
        val error = Throwable(entry.value)
        val raw = error.stackTraceToString()
        val actual = renderThrowable(error)
        val expected = if (raw.length <= 2048) raw else raw.substring(0, 2048) + "..."
        check(actual == expected)
        append(entry.index).append('|').append(actual == expected).append('|')
            .append(raw.units()).append('|').append(actual.units()).append('\n')
    }
}
