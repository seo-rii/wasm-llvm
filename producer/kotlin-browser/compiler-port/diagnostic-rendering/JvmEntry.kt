package org.jetbrains.kotlin.portable.diagnostics.probe

import java.util.Locale

fun main() {
    val baseline = observeDiagnosticFormats()
    for (locale in listOf(Locale.US, Locale.GERMANY, Locale.forLanguageTag("tr-TR"), Locale.forLanguageTag("ar-EG"))) {
        Locale.setDefault(locale)
        check(observeDiagnosticFormats() == baseline) { "Diagnostic profile depends on default locale: $locale" }
    }
    print(baseline)
}
