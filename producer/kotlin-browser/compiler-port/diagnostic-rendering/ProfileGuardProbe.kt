package org.jetbrains.kotlin.portable.diagnostics.probe

import org.jetbrains.kotlin.portable.diagnostics.DiagnosticMessageFormat

/** Rejection contract belongs to the restricted port, not to the full JDK formatter. */
fun observeDiagnosticProfileGuards(): String {
    var checks = 0
    fun unsupported(pattern: String, value: Any?) {
        try {
            DiagnosticMessageFormat(pattern).format(arrayOf(value))
            error("Unclosed diagnostic operation unexpectedly returned: $pattern")
        } catch (_: UnsupportedOperationException) {
            checks++
        }
    }
    for (value in listOf<Any>(true, 1L, 1.toByte(), 1.toShort(), 1.5, 1.5f, object {})) unsupported("{0}", value)
    for (value in listOf<Any>(1L, 1.5, Double.NaN, Double.POSITIVE_INFINITY)) unsupported("{0,choice,0#none|1#one}", value)
    for (style in listOf("date", "time", "number,currency", "number,percent", "number,0.00")) unsupported("{0,$style}", 1)
    check(DiagnosticMessageFormat.DIAGNOSTIC_LOCALE == "en-US")
    check(DiagnosticMessageFormat("{0}").format(arrayOf("String")) == "String")
    check(DiagnosticMessageFormat("{0}").format(arrayOf(1234)) == "1,234")
    return "unsupported-profile-checks=$checks; locale=en-US; accepted=String,Int,null\n"
}
