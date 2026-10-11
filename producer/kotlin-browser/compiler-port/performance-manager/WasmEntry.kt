/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
@file:OptIn(kotlin.js.ExperimentalJsExport::class)
package org.jetbrains.kotlin.util.portable.probe

@kotlin.js.JsExport
fun performanceManagerObservation(): String = observePerformanceManager().also { verifyHostReplayComplete() }
