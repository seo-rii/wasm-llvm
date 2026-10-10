package org.jetbrains.kotlin.js.inputprobe
import java.nio.ByteBuffer
import java.nio.BufferUnderflowException
class ProbeInput(private val source: ByteArray) {
    private val buffer = ByteBuffer.wrap(source)
    val position: Int get() = buffer.position()
    fun readByte(): Byte = buffer.get()
    fun readInt(): Int = buffer.int
    fun readDouble(): Double = buffer.double
    fun seek(offset: Int) { buffer.position(offset) }
    fun readUtf8(offset: Int, length: Int): String = String(source, offset, length, Charsets.UTF_8)
}
fun inputFailure(error: Throwable): String = if (error is BufferUnderflowException) "underflow" else error::class.simpleName ?: "Throwable"
