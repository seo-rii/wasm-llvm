package org.jetbrains.kotlin.portable.diagnostics.probe

expect fun formatConstructor(pattern: String, arguments: Array<out Any?>?): String
expect fun formatCompanion(pattern: String, arguments: Array<out Any?>): String

data class FormatCase(val id: String, val pattern: String, val arguments: Array<out Any?>?)

private fun outcome(block: () -> String): String = try {
    "ok:" + block().replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
} catch (_: IllegalArgumentException) {
    "illegal-argument"
} catch (_: IndexOutOfBoundsException) {
    "bounds"
}

/** Real constructor/instance and static vararg call shapes used by the selected Kotlin renderers. */
fun observeDiagnosticFormats(): String {
    val cases = mutableListOf(
        FormatCase("unicode", "한글 é 中 \uD83D\uDE00 {0}", arrayOf("é 中 \uD83D\uDE00")),
        FormatCase("quotes", "can't ''{0}'' '{1}' ''", arrayOf("first", "second")),
        FormatCase("unclosed-quote", "'prefix {0}", arrayOf("hidden")),
        FormatCase("rendered-string-is-not-a-pattern", "{0}", arrayOf("quoted '{1}' {0}\n한글")),
        FormatCase("adjacent-repeated", "{1}{0}{1}{0}", arrayOf("A", "B")),
        FormatCase("missing", "{0}:{3}", arrayOf("A")),
        FormatCase("null-array", "{0}:{1}", null),
        FormatCase("null-value", "{0}:{1}", arrayOf(null, "B")),
        FormatCase("plus-zero", "{+0000}", arrayOf("A")),
        FormatCase("minus-zero", "{-0}", arrayOf("A")),
        FormatCase("arabic-index", "{\u0660}", arrayOf("A")),
        FormatCase("fullwidth-index", "{\uFF10}", arrayOf("A")),
        FormatCase("negative-index", "{-1}", arrayOf("A")),
        FormatCase("index-overflow", "{2147483648}", arrayOf("A")),
        FormatCase("negative-index-overflow", "{-2147483649}", arrayOf("A")),
        FormatCase("largest-index", "{9999}", arrayOf("A")),
        FormatCase("implementation-index-limit", "{10000}", arrayOf("A")),
        FormatCase("empty-index", "{}", arrayOf("A")),
        FormatCase("incomplete-index", "{0", arrayOf("A")),
        FormatCase("incomplete-nested-braces", "{0,choice,0#{1}", arrayOf<Any?>(0, "A")),
        FormatCase("unknown-format", "{0,unknown}", arrayOf("A")),
        FormatCase("integer-whitespace-case", "{0, NUMBER , INTEGER }", arrayOf(1234567)),
        FormatCase("integer-java-trim", "{0,\u001Fnumber\u001F,\u001Finteger\u001F}", arrayOf(1234567)),
        FormatCase("integer-unclosed-unicode-trim", "{0,\u00A0number\u00A0,integer}", arrayOf(1234567)),
        FormatCase("number-string", "{0,number,integer}", arrayOf("123")),
        FormatCase("choice-string", "{0,choice,0#none|1#one}", arrayOf("1")),
        FormatCase("choice-quoted", "{0,choice,0#'none|at all'|1#one ''quote''|1<many}", arrayOf(0)),
        FormatCase("choice-nested", "{0,choice,0#none|1#one|1<{0,number,integer} items for {1}}", arrayOf<Any?>(1000, "x{0}'y")),
        FormatCase("choice-order", "{0,choice,1#one|0#none}", arrayOf(0)),
        FormatCase("choice-empty", "{0,choice,}", arrayOf(0)),
        FormatCase("choice-missing-limit", "{0,choice,#none}", arrayOf(0))
    )
    for (number in listOf(Int.MIN_VALUE, -1234567, -1, 0, 1, 2, 999, 1000, 1234567, Int.MAX_VALUE)) {
        cases.add(FormatCase("integer:$number", "{0}/{0,number}/{0,number,integer}", arrayOf(number)))
        cases.add(FormatCase("choice:$number", "{0,choice,-∞#negative|0#zero|1#one|1<many|∞#infinite}", arrayOf(number)))
        cases.add(FormatCase("choice-boundary:$number", "{0,choice,-1≤negative|0≤zero|0<positive}", arrayOf(number)))
    }
    cases.addAll(officialLiteralCases())
    cases.addAll(officialRawIntCases())
    val records = mutableListOf<String>()
    for (case in cases) {
        records.add(case.id + "/constructor=" + outcome { formatConstructor(case.pattern, case.arguments) })
        if (case.arguments != null) records.add(case.id + "/companion=" + outcome { formatCompanion(case.pattern, case.arguments) })
    }
    // Dynamic adaptive templates use appendSafe to quote literal names before inserting String parameters.
    val names = listOf("Plain", "O'Brien", "A{0}", "한글\uD83D\uDE00", "'{}'", "")
    for (index in names.indices) {
        val name = names[index];
        val safe = "'" + name.replace("'", "''") + "'"
        val pattern = safe + "<{0}, {1}>{2}"
        records.add("adaptive:$index=" + outcome { formatCompanion(pattern, arrayOf("X{0}", "Y'", "?")) })
    }
    return records.joinToString("\n") + "\n"
}
