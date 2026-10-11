/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.util.portable.probe

fun main(arguments: Array<String>) {
    java.util.Locale.setDefault(java.util.Locale.ENGLISH)
    java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC"))
    val observed = observePerformanceManager()
    java.io.File(arguments.single()).writeText(hostOracleSource())
    print(observed)
}
