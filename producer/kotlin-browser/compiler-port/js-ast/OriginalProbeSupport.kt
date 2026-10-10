/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.astprobe

import java.io.StringReader
import java.math.BigInteger
import org.jetbrains.kotlin.js.backend.ast.JsBigIntLiteral

fun byteInteger(bytes: ByteArray): JsBigIntLiteral = JsBigIntLiteral(BigInteger(bytes))

fun readerObservations(): List<String> {
    val result = ArrayList<String>()
    val reader = StringReader("A\uD83D\uDE00\nB")
    val buffer = CharArray(4) { '.' }
    for (n in listOf(0, 2, 2, 2, 2)) {
        val count = reader.read(buffer, 1, n)
        result.add("reader.$n=$count/" + buffer.joinToString { it.code.toString(16) })
    }
    reader.close()
    try { reader.read(); result.add("reader.closed=NO_EXCEPTION") }
    catch (error: java.io.IOException) { result.add("reader.closed=closed-reader/${error.message}") }
    return result
}
