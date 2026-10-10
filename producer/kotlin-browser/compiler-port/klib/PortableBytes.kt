package org.jetbrains.kotlin.portable.klib

/** Explicit host limits; these bound KLIB buffers, not the browser's whole GC heap. */
object KlibByteLimits {
    const val MAX_BUFFER_BYTES: Int = 64 * 1024 * 1024
    const val MAX_TABLE_ENTRIES: Int = 1024 * 1024
}

/** Big-endian, bounds-checked replacement for the ByteBuffer operations used by the official KLIB readers. */
class PortableByteCursor private constructor(private val bytes: ByteArray) {
    private var offset = 0

    fun position(): Int = offset

    fun position(newPosition: Int): PortableByteCursor {
        checkRange(newPosition, 0)
        offset = newPosition
        return this
    }

    fun limit(): Int = bytes.size
    fun remaining(): Int = bytes.size - offset

    fun checkRange(start: Int, length: Int, end: Int = bytes.size) {
        require(end in 0..bytes.size && start >= 0 && length >= 0 && start <= end && length <= end - start) {
            "KLIB byte range is out of bounds"
        }
    }

    fun checkTableCount(count: Int, minimumRecordBytes: Int, end: Int = bytes.size) {
        require(count in 0..KlibByteLimits.MAX_TABLE_ENTRIES && minimumRecordBytes > 0) { "Invalid or excessive KLIB table count" }
        checkRange(offset, 0, end)
        require(count <= (end - offset) / minimumRecordBytes) { "Truncated KLIB table index" }
    }

    fun get(): Byte = readByte(bytes.size)

    fun readByte(end: Int): Byte {
        checkRange(offset, 1, end)
        return bytes[offset++]
    }

    val int: Int get() = readInt(bytes.size)

    fun readInt(end: Int): Int {
        checkRange(offset, 4, end)
        val result = ((bytes[offset].toInt() and 255) shl 24) or
            ((bytes[offset + 1].toInt() and 255) shl 16) or
            ((bytes[offset + 2].toInt() and 255) shl 8) or (bytes[offset + 3].toInt() and 255)
        offset += 4
        return result
    }

    fun get(destination: ByteArray, destinationOffset: Int, length: Int): PortableByteCursor {
        checkRange(offset, length)
        require(destinationOffset >= 0 && length >= 0 && destinationOffset <= destination.size && length <= destination.size - destinationOffset) {
            "KLIB destination range is out of bounds"
        }
        bytes.copyInto(destination, destinationOffset, offset, offset + length)
        offset += length
        return this
    }

    companion object {
        fun wrap(bytes: ByteArray): PortableByteCursor {
            require(bytes.size <= KlibByteLimits.MAX_BUFFER_BYTES) { "KLIB buffer exceeds the byte limit" }
            return PortableByteCursor(bytes)
        }
    }
}

/** Only the three actual DataOutput operations required by lowLevelWriters.kt. */
class PortableDataOutput(private val maximumBytes: Int = KlibByteLimits.MAX_BUFFER_BYTES) {
    private var bytes: ByteArray
    private var size = 0
    private var failed = false

    init {
        require(maximumBytes in 0..KlibByteLimits.MAX_BUFFER_BYTES) { "Invalid KLIB output limit" }
        bytes = ByteArray(minOf(256, maximumBytes))
    }

    private fun reserve(count: Int) {
        check(!failed) { "Failed KLIB output must be discarded" }
        if (count < 0 || count > maximumBytes - size) {
            failed = true
            error("KLIB output exceeds the byte limit")
        }
        val required = size + count
        if (required > bytes.size) {
            val doubled = minOf(maximumBytes.toLong(), maxOf(1L, bytes.size.toLong() * 2)).toInt()
            bytes = bytes.copyOf(maxOf(required, doubled))
        }
    }

    fun write(value: Int) {
        reserve(1)
        bytes[size++] = value.toByte()
    }

    fun write(value: ByteArray) {
        reserve(value.size)
        value.copyInto(bytes, size)
        size += value.size
    }

    fun writeInt(value: Int) {
        reserve(4)
        bytes[size++] = (value ushr 24).toByte()
        bytes[size++] = (value ushr 16).toByte()
        bytes[size++] = (value ushr 8).toByte()
        bytes[size++] = value.toByte()
    }

    fun toByteArray(): ByteArray {
        check(!failed) { "Failed KLIB output must be discarded" }
        return bytes.copyOf(size)
    }
}

/** java.lang.Character's exact UTF-16 surrogate operations used by the official WobblyTF8 codec. */
internal object PortableCharacter {
    fun isHighSurrogate(value: Char): Boolean = value in '\uD800'..'\uDBFF'
    fun isLowSurrogate(value: Char): Boolean = value in '\uDC00'..'\uDFFF'
    fun toCodePoint(high: Char, low: Char): Int = ((high.code - 0xD800) shl 10) + low.code - 0xDC00 + 0x10000
    fun highSurrogate(codePoint: Int): Char = ((codePoint ushr 10) + 0xD7C0).toChar()
    fun lowSurrogate(codePoint: Int): Char = ((codePoint and 0x3FF) + 0xDC00).toChar()
}
