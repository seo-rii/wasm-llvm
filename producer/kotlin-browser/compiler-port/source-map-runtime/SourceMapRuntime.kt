/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.portable.sourcemap

import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.config.CompilerConfigurationKey

/** Explicit working files and print destination owned by one compilation request. */
class SourceMapRuntime(val files: SourceMapTextStore, val printOutput: SourceMapPrintOutput)

private val REQUEST_SOURCE_MAP_RUNTIME = CompilerConfigurationKey.create<SourceMapRuntime>("request source map runtime")

fun installRequestSourceMapRuntime(configuration: CompilerConfiguration, runtime: SourceMapRuntime) {
    configuration.put(REQUEST_SOURCE_MAP_RUNTIME, runtime)
}

/** Capture the current request value before constructing a source map. */
fun requestSourceMapRuntime(configuration: CompilerConfiguration): SourceMapRuntime =
    requireNotNull(configuration[REQUEST_SOURCE_MAP_RUNTIME]) { "Source map runtime is not installed for this request" }
