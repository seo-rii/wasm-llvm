@file:OptIn(kotlin.js.ExperimentalJsExport::class)
package org.jetbrains.kotlin.portable.diagnostics.probe
import kotlin.js.JsExport
@JsExport fun diagnosticFormatProbe(): String = observeDiagnosticFormats()
@JsExport fun diagnosticProfileGuardProbe(): String = observeDiagnosticProfileGuards()
