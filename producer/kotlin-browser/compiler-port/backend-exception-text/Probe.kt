package org.jetbrains.kotlin.portable.backendtext.probe

// Reversible UTF-16 encoding preserves every input/output code unit, including
// whitespace, newlines, supplementary characters and unpaired surrogates.
private fun String.utf16Hex(): String = buildString {
    for (character in this@utf16Hex) append(character.code.toString(16).padStart(4, '0'))
}

fun observeBackendText(render: (String) -> String): String = buildString {
    val names = listOf(
        "java.lang.StackOverflowError", "java.lang.NullPointerException", "StackOverflowError", "NullPointerException",
        "other.StackOverflowError", "other.NullPointerException", "java.lang.IllegalStateException", "Example", "a.b.C", "a.", ".",
        "예외.종류", "unicode.ΔException", "unicode.错误", "unicode.𝒳Error", "unicode.\u0000Error", "unicode.\ud800Error",
        "unicode.\u00a0Error", "unicode.\u0085Error", "unicode.\u2003Error", "unicode.\u2028Error", "unicode.\u2029Error",
    )
    val suffixes = listOf("", ":", ": ", ":  ", ": \t", ": \n", ": \r", ": \r\n", ": \u000b", ": \u000c", ": \u0085", ": \u00a0",
        ": \u1680", ": \u2003", ": \u2028", ": \u2029", ": \u202f", ": \u3000", ": null", ": message", ":  keep both  ",
        ": 예외 상세", ": message\nnext", ": message\rnext", ": message\u0085next", ": message\u2028next", ": 😀 detail", ": \ud800 detail")
    val inputs = mutableListOf("", "null", "Exception", "Exception ", "Exception  ", "exception java.lang.StackOverflowError",
        " Exception java.lang.StackOverflowError", "Exception\tjava.lang.StackOverflowError", "Exception java.lang.StackOverflowError\n",
        "plain text: unchanged", "Exception foo: message: detail", "Exception foo : message", "Exception : message")
    for (name in names) for (suffix in suffixes) inputs.add("Exception $name$suffix")
    var bits = 0x13579bdf
    val alphabet = listOf('a', '.', ':', ' ', '\t', '\n', '\r', '\u0085', '\u00a0', '\u2003', '\u2028', '\u2029', '오', '\ud800', '\udfff')
    repeat(1024) {
        val text = buildString {
            append("Exception ")
            repeat(1 + (bits ushr 25)) { bits = bits * 1664525 + 1013904223; append(alphabet[(bits ushr 16) % alphabet.size]) }
        }
        inputs.add(text)
    }
    for ((index, input) in inputs.withIndex()) {
        append(index).append('|').append(input.utf16Hex()).append('|').append(render(input).utf16Hex()).append('\n')
    }
}
