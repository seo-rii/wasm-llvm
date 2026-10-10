@file:OptIn(kotlin.js.ExperimentalJsExport::class)
package org.jetbrains.kotlin.portable.wasmconsumers.probe
@kotlin.js.JsExport
fun wasmConsumerProbe(): String = observeWasmConsumers()
