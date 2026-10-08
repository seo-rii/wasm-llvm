package org.jetbrains.kotlin.wasm.writerprobe

import org.jetbrains.kotlin.utils.readUnsignedLeb128
import org.jetbrains.kotlin.wasm.ir.ByteWriterWithOffsetWrite
import org.jetbrains.kotlin.wasm.ir.WasmBinaryData
import org.jetbrains.kotlin.wasm.ir.WasmBinaryData.Companion.toByteArray

private class Observation(val id: String, val category: String, val bytes: ByteArray)

private fun ByteArray.hex(): String = buildString(size * 2) {
    for (byte in this@hex) {
        val unsigned = byte.toInt() and 0xff
        append("0123456789abcdef"[unsigned shr 4])
        append("0123456789abcdef"[unsigned and 15])
    }
}

fun fileProbeData(): WasmBinaryData = ByteWriterWithOffsetWrite().apply {
    writeBytes(ByteArray(65) { it.toByte() })
    writeVarUInt32FixedSize(0x12345678, 9)
    writeUInt64(0xFEDCBA9876543210uL, 8, 48)
}.getBinaryData()

fun writerSnapshot(): String {
    val observed = mutableListOf<Observation>()
    fun record(id: String, category: String, operation: ByteWriterWithOffsetWrite.() -> Unit) {
        val writer = ByteWriterWithOffsetWrite()
        writer.operation()
        val bytes = writer.getBinaryData().toByteArray()
        check(writer.written == bytes.size)
        observed += Observation(id, category, bytes)
    }

    val unsigned = listOf(0u, 1u, 0x7fu, 0x80u, 0x3fffu, 0x4000u, 0x0fff_ffffu, 0x1000_0000u, UInt.MAX_VALUE)
    for (value in unsigned) {
        record("uleb-$value", "unsigned-leb128") { writeVarUInt32(value) }
        record("fixed-uleb-$value", "fixed-five-byte-leb128") { writeVarUInt32FixedSize(value) }
    }
    val signed = listOf(Long.MIN_VALUE, Int.MIN_VALUE.toLong(), -8193L, -8192L, -129L, -128L, -65L, -64L,
        -63L, -1L, 0L, 1L, 63L, 64L, 127L, 128L, 8191L, 8192L, Int.MAX_VALUE.toLong(), Long.MAX_VALUE)
    for (value in signed) record("sleb64-$value", "signed-leb128") { writeVarInt64(value) }
    for (value in listOf(Int.MIN_VALUE, -65, -64, -1, 0, 63, 64, Int.MAX_VALUE)) {
        record("sleb32-$value", "signed-leb128") { writeVarInt32(value) }
    }
    for (value in listOf(Byte.MIN_VALUE, (-65).toByte(), (-64).toByte(), (-1).toByte(), 0.toByte(), 63.toByte(), 64.toByte(), Byte.MAX_VALUE)) {
        record("sleb7-$value", "signed-leb128") { writeVarInt7(value) }
    }
    for (value in listOf(0.toUShort(), 127.toUShort(), 128.toUShort(), UShort.MAX_VALUE)) {
        record("uleb7-$value", "unsigned-leb128") { writeVarUInt7(value) }
    }
    record("booleans", "boolean") { writeBoolean(false); writeBoolean(true); writeVarUInt1(false); writeVarUInt1(true) }
    record("fixed-widths", "little-endian") {
        writeByte((-1).toByte()); writeUByte(0x80u); writeUInt16(0xfedcu); writeUInt32(0xfedcba98u)
        writeUInt64(0xfedcba9876543210uL)
        for (size in listOf(1, 2, 4, 8)) writeUInt64(0xfedcba9876543210uL, size)
    }
    // Floating-point values reach this writer as raw integer bits; no floating-point arithmetic is substituted.
    for (bits in listOf(0, Int.MIN_VALUE, 0x3f800000, 0x7f800000, 0xff800000u.toInt(), 0x7fc01234, 0x7f800001)) {
        record("float-bits-${bits.toUInt()}", "float-bit-pattern") { writeUInt32(bits.toUInt()) }
    }
    for (bits in listOf(0uL, 0x8000000000000000uL, 0x3ff0000000000000uL, 0x7ff0000000000000uL,
        0xfff0000000000000uL, 0x7ff8000000001234uL, 0x7ff0000000000001uL)) {
        record("double-bits-$bits", "double-bit-pattern") { writeUInt64(bits) }
    }
    record("growth", "buffer-growth") {
        for (index in 0 until 65) writeByte(index.toByte())
        writeBytes(ByteArray(4097) { (it * 37).toByte() })
    }
    record("backpatch-existing", "backpatch") {
        writeVarUInt32FixedSize(0u); writeBytes(byteArrayOf(0x11, 0x22, 0x33))
        writeVarUInt32FixedSize(1000, 0); writeUInt64(0xfedcba98uL, 4, 4)
        check(written == 8)
    }
    record("backpatch-extends", "backpatch") {
        writeBytes(byteArrayOf(1, 2, 3)); writeUInt64(0x1234uL, 2, 8)
        check(written == 10)
    }
    record("backpatch-widths", "backpatch") {
        writeBytes(ByteArray(16) { 0x55 }); writeUInt64(0x80uL, 1, 0); writeUInt64(0x1234uL, 2, 1)
        writeUInt64(0xfedcba98uL, 4, 3); writeUInt64(0xfedcba9876543210uL, 8, 7)
        check(written == 16)
    }
    record("backpatch-unsigned-int", "backpatch") { writeVarUInt32FixedSize(-1, 0); check(written == 5) }
    val mutableWriter = ByteWriterWithOffsetWrite().apply { writeBytes(byteArrayOf(1, 2, 3)) }
    val mutableSnapshot = mutableWriter.getBinaryData()
    mutableWriter.writeUInt64(0xabuL, 1, 0)
    observed += Observation("snapshot-before-growth", "binary-data-ownership", mutableSnapshot.toByteArray())
    val oldSnapshot = mutableWriter.getBinaryData()
    mutableWriter.writeBytes(ByteArray(64) { 0x44 })
    mutableWriter.writeUInt64(0xceuL, 1, 0)
    observed += Observation("snapshot-after-growth", "binary-data-ownership", oldSnapshot.toByteArray())
    observed += Observation("file-adapter-bytes", "file-adapter", fileProbeData().toByteArray())

    for (value in unsigned) {
        val bytes = observed.single { it.id == "uleb-$value" }.bytes
        var offset = 0
        check(readUnsignedLeb128({ bytes[offset++] }) == value && offset == bytes.size)
    }
    for (bytes in listOf(byteArrayOf(0x80.toByte(), 0x80.toByte(), 0x80.toByte(), 0x80.toByte(), 0x10),
        byteArrayOf(0x80.toByte(), 0x80.toByte(), 0x80.toByte(), 0x80.toByte(), 0x80.toByte(), 0))) {
        var offset = 0
        var rejected = false
        try { readUnsignedLeb128({ bytes[offset++] }) } catch (_: IllegalStateException) { rejected = true }
        check(rejected)
    }
    var rejectedSize = false
    try { ByteWriterWithOffsetWrite().writeUInt64(0uL, 3) } catch (_: IllegalStateException) { rejectedSize = true }
    check(rejectedSize)

    return buildString {
        append("{\"cases\":[")
        observed.forEachIndexed { index, observation ->
            if (index != 0) append(',')
            append("{\"id\":\"").append(observation.id).append("\",\"category\":\"")
                .append(observation.category).append("\",\"bytes\":").append(observation.bytes.size)
                .append(",\"hex\":\"").append(observation.bytes.hex()).append("\"}")
        }
        append("],\"checks\":{\"unsignedRoundTrips\":9,\"invalidUnsignedRejected\":2,\"invalidWidthRejected\":true}}")
    }
}
