package org.jetbrains.kotlin.portable.rawfir.probe
@OptIn(kotlin.js.ExperimentalWasmJsInterop::class)
@kotlin.js.JsExport
fun numericObservation(): String = numericObservations()

private class NamedClassBoundary
@OptIn(kotlin.js.ExperimentalWasmJsInterop::class)
@kotlin.js.JsExport
fun classNameBoundary(): String = listOf(NamedClassBoundary(), object {}).joinToString("|") { value ->
    try { value::class.qualifiedName ?: "<anonymous>" }
    catch (error: Throwable) { "throws:" + error::class.simpleName }
}
