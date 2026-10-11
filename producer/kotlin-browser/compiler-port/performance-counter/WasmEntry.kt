/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.util.portable.probe
import kotlin.js.JsExport
@JsExport
fun performanceCounterObservation(): String = observePerformanceCounter()
