/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.astprobe
import kotlin.js.JsExport
@JsExport
fun astProbeJson(): String = astObservation()
