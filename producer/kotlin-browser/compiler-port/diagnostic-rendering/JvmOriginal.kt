package org.jetbrains.kotlin.portable.diagnostics.probe

import java.text.MessageFormat
import java.util.Locale

actual fun formatConstructor(pattern: String, arguments: Array<out Any?>?): String =
    MessageFormat(pattern, Locale.US).format(arguments)

actual fun formatCompanion(pattern: String, arguments: Array<out Any?>): String {
    // The audit profile is en-US, independently of the host's process default locale.
    val previous = Locale.getDefault()
    try {
        Locale.setDefault(Locale.US)
        return MessageFormat.format(pattern, *arguments)
    } finally {
        Locale.setDefault(previous)
    }
}
