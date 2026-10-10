/* Bounded observer cursor/output only; no shipping ByteBuffer or Java I/O façade. */
package org.jetbrains.kotlin.js.astintegerprobe
class ProbePrefixUnderflow : Exception()
class ProbeIntegerCursor(private val source: ByteArray) {
    private var offset = 0
    val int: Int get() {
        if (source.size - offset < 4) throw ProbePrefixUnderflow()
        var value = 0
        repeat(4) { value = (value shl 8) or (source[offset++].toInt() and 255) }
        return value
    }
    fun position(): Int = offset
    fun position(value: Int) { require(value in 0..source.size); offset = value }
}
class LiteralOutput {
    private val data = ArrayList<Byte>()
    fun writeByte(value: Int) { data.add(value.toByte()) }
    fun writeInt(value: Int) { for (shift in listOf(24, 16, 8, 0)) writeByte(value ushr shift) }
    fun write(bytes: ByteArray) { for (byte in bytes) data.add(byte) }
    fun bytes(): ByteArray = data.toByteArray()
}
fun failureCategory(error: Throwable): String = if (error is ProbePrefixUnderflow) "prefix-underflow" else error::class.simpleName ?: "Throwable"
