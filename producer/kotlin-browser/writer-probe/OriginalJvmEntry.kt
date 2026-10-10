package org.jetbrains.kotlin.wasm.writerprobe

import java.io.File
import org.jetbrains.kotlin.wasm.ir.WasmBinaryData.Companion.writeTo

fun main(args: Array<String>) {
    fileProbeData().writeTo(File(args.single()))
    println(writerSnapshot())
}
