package org.jetbrains.kotlin.portable.mainentry.runtime

import java.io.File

/** Only asserts class origins and calls the real compiler CLI; no IR or entry selection. */
fun main(arguments: Array<String>) {
    require(arguments.size >= 2)
    val overlay = File(arguments[0]).canonicalFile
    val compiler = File(arguments[1]).canonicalFile
    val classes = listOf(
        "org.jetbrains.kotlin.ir.backend.js.utils.JsMainFunctionDetector" to overlay,
        "org.jetbrains.kotlin.ir.backend.js.utils.JsMainFunctionDetectorKt" to overlay,
        "org.jetbrains.kotlin.backend.wasm.lower.GenerateMainFunctionWrappers" to overlay,
        "org.jetbrains.kotlin.backend.wasm.lower.GenerateMainFunctionCallsKt" to overlay,
        "org.jetbrains.kotlin.backend.wasm.WasmBackendContext" to compiler,
        "org.jetbrains.kotlin.cli.js.KotlinWasmCompiler" to compiler,
    )
    for ((name, expected) in classes) {
        val type = Class.forName(name)
        val actual = File(type.protectionDomain.codeSource.location.toURI()).canonicalFile
        check(actual == expected) { "Unexpected origin for $name: $actual" }
        System.err.println("OFFICIAL_MAIN_ORIGIN\t$name\t${actual.path}")
    }
    val entry = Class.forName("org.jetbrains.kotlin.cli.js.KotlinWasmCompiler")
        .getMethod("main", Array<String>::class.java)
    entry.invoke(null, arguments.drop(2).toTypedArray())
}
