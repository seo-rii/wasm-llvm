@file:OptIn(kotlin.js.ExperimentalJsExport::class)

package org.jetbrains.kotlin.wasm.writerprobe

import kotlin.js.JsExport

@JsExport
fun writerProbeSnapshot(): String = writerSnapshot()

@JsExport
fun writerProbePortableChecks(): String = portableChecks()
