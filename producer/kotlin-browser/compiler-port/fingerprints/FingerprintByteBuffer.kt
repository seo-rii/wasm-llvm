/* Compiler fingerprint ByteBuffer boundary; original algorithms are unchanged. */
package org.jetbrains.kotlin.backend.common.serialization

/** Only the original fingerprint operations, with ByteBuffer's default big endian order. */
internal class FingerprintByteBuffer private constructor(private val bytes: ByteArray) {
    private var position = 0

    fun putLong(value: Long): FingerprintByteBuffer {
        putLong(position, value)
        position += Long.SIZE_BYTES
        return this
    }

    fun putLong(index: Int, value: Long): FingerprintByteBuffer {
        checkIndex(index)
        for (offset in 0 until Long.SIZE_BYTES) {
            bytes[index + offset] = (value ushr ((Long.SIZE_BYTES - 1 - offset) * 8)).toByte()
        }
        return this
    }

    fun getLong(index: Int): Long {
        checkIndex(index)
        var result = 0L
        for (offset in 0 until Long.SIZE_BYTES) {
            result = (result shl 8) or (bytes[index + offset].toLong() and 255L)
        }
        return result
    }

    fun array(): ByteArray = bytes

    private fun checkIndex(index: Int) {
        if (index < 0 || index > bytes.size - Long.SIZE_BYTES) throw IndexOutOfBoundsException()
    }

    companion object {
        fun allocate(size: Int): FingerprintByteBuffer = FingerprintByteBuffer(ByteArray(size))
        fun wrap(bytes: ByteArray): FingerprintByteBuffer = FingerprintByteBuffer(bytes)
    }
}
