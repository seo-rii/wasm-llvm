package org.jetbrains.kotlin.protobuf

/** The only stream boundary: supplied immutable library bytes and bounded sinks. */
interface ProtoInput {
    fun read(): Int
    fun read(bytes: ByteArray, offset: Int, length: Int): Int {
        require(offset >= 0 && length >= 0 && offset <= bytes.size - length)
        if (length == 0) return 0
        var count = 0
        while (count < length) { val next = read(); if (next == -1) return if (count == 0) -1 else count; require(next in 0..255); bytes[offset + count++] = next.toByte() }
        return count
    }
}
interface ProtoOutput {
    fun write(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size - offset)
    fun write(value: Int) = write(byteArrayOf(value.toByte()))
}
class ByteArrayProtoInput(bytes: ByteArray, private val offset: Int = 0, private val length: Int = bytes.size - offset) : ProtoInput {
    private val buffer = bytes.copyOf()
    private var position = 0
    init { require(offset >= 0 && length >= 0 && offset <= bytes.size - length) }
    override fun read(): Int = if (position == length) -1 else buffer[offset + position++].toInt() and 255
    override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
        require(offset >= 0 && length >= 0 && offset <= bytes.size - length)
        if (length == 0) return 0
        if (position == this.length) return -1
        val count = minOf(length, this.length - position)
        buffer.copyInto(bytes, offset, this.offset + position, this.offset + position + count); position += count
        return count
    }
}
class ByteArrayProtoOutput(private val limit: Int = 64 * 1024 * 1024) : ProtoOutput {
    private val output = CodedOutputStream()
    init { require(limit >= 0) }
    override fun write(bytes: ByteArray, offset: Int, length: Int) {
        if (length > limit - output.totalBytesWritten) throw IllegalStateException("Protocol output exceeded byte limit")
        output.writeRawBytes(bytes, offset, length)
    }
    fun toByteArray(): ByteArray = output.toByteArray()
}
abstract class AbstractMessageLite : MessageLite {
    fun writeTo(output: ProtoOutput) = output.write(toByteArray())
    fun writeDelimitedTo(output: ProtoOutput) {
        val sink = CodedOutputStream(); sink.writeMessageNoTag(this); output.write(sink.toByteArray())
    }
}
internal fun ProtoInput.readProtocolBytes(length: Int): ByteArray {
    if (length < 0) invalid("Negative protocol length")
    if (length > 64 * 1024 * 1024) invalid("Protocol message exceeded size limit")
    val bytes = ByteArray(length)
    var offset = 0
    while (offset < length) {
        val count = read(bytes, offset, length - offset)
        if (count <= 0 || count > length - offset) invalid("Truncated or invalid protocol input stream")
        offset += count
    }
    return bytes
}
internal fun ProtoInput.readAllProtocolBytes(): ByteArray {
    val output = CodedOutputStream(); val buffer = ByteArray(8192)
    var count = 0
    while (true) {
        val read = read(buffer, 0, buffer.size)
        if (read == -1) return output.toByteArray()
        if (read <= 0 || read > buffer.size) invalid("Invalid protocol input stream result")
        if (read > 64 * 1024 * 1024 - count) invalid("Protocol message exceeded size limit")
        count += read; output.writeRawBytes(buffer, 0, read)
    }
}
internal fun ProtoInput.readProtocolLength(first: Int): Int {
    if (first !in 0..255) invalid("Invalid protocol input byte")
    var result = (first and 127).toLong()
    if (first and 128 == 0) return result.toInt()
    for (shift in 7..63 step 7) {
        val byte = read()
        if (byte !in 0..255) invalid("Truncated protocol length")
        result = result or ((byte and 127).toLong() shl shift)
        if (byte and 128 == 0) return result.toInt()
    }
    invalid("Malformed protocol length")
}
