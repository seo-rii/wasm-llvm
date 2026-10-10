package org.jetbrains.kotlin.portable.diagnostics.probe

import org.jetbrains.kotlin.portable.diagnostics.DiagnosticMessageFormat

actual fun formatConstructor(pattern: String, arguments: Array<out Any?>?): String =
    DiagnosticMessageFormat(pattern).format(arguments)

actual fun formatCompanion(pattern: String, arguments: Array<out Any?>): String =
    DiagnosticMessageFormat.format(pattern, *arguments)
