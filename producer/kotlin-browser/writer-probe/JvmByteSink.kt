package org.jetbrains.kotlin.wasm.ir

import java.io.File
import java.io.OutputStream
import org.jetbrains.kotlin.wasm.ir.WasmBinaryData.Companion.writeTo

class JvmByteSink(private val stream: OutputStream) : ByteSink {
    override fun write(value: Int) = stream.write(value)
    override fun write(bytes: ByteArray) = stream.write(bytes)
    override fun write(bytes: ByteArray, offset: Int, length: Int) = stream.write(bytes, offset, length)
}

// File IO stays in the JVM source set. Its import changes are an explicit probe boundary.
object JvmWasmBinaryData {
    fun WasmBinaryData.writeTo(file: File) {
        file.outputStream().use { stream -> writeTo(JvmByteSink(stream)) }
    }
}
