package org.jetbrains.kotlin.portable.interning.probe

@OptIn(kotlin.js.ExperimentalWasmJsInterop::class)
@kotlin.js.JsExport
fun irInterningObservation(): String = observation()
