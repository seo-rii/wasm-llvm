/*
 * Byte storage adapter for the official Kotlin writer probe.
 * The writer and LEB128 algorithms remain in their pinned upstream files.
 */
package org.jetbrains.kotlin.wasm.ir

interface ByteSink {
    fun write(value: Int)
    fun write(bytes: ByteArray)
    fun write(bytes: ByteArray, offset: Int, length: Int)
}

open class BoundedByteSink(private val maxBytes: Int = 8 * 1024 * 1024) : ByteSink {
    init {
        require(maxBytes >= 0) { "Negative byte sink limit" }
    }

    protected var buf: ByteArray = ByteArray(minOf(32, maxBytes))
    protected var count: Int = 0
        set(value) {
            require(value >= 0 && value <= maxBytes) { "Byte sink offset outside limit" }
            field = value
        }

    fun size(): Int = count

    override fun write(value: Int) {
        ensureCapacity(1)
        buf[count] = value.toByte()
        count++
    }

    override fun write(bytes: ByteArray) = write(bytes, 0, bytes.size)

    override fun write(bytes: ByteArray, offset: Int, length: Int) {
        require(offset >= 0 && length >= 0 && offset <= bytes.size && length <= bytes.size - offset) {
            "Byte sink input range outside array"
        }
        ensureCapacity(length)
        bytes.copyInto(buf, count, offset, offset + length)
        count += length
    }

    private fun ensureCapacity(additionalBytes: Int) {
        check(additionalBytes <= maxBytes - count) { "Byte sink limit exceeded" }
        val required = count + additionalBytes
        if (required > buf.size) {
            val doubled = minOf(maxBytes.toLong(), maxOf(32L, buf.size.toLong() * 2)).toInt()
            buf = buf.copyOf(maxOf(required, doubled))
        }
    }
}
