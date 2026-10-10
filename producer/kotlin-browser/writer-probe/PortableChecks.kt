package org.jetbrains.kotlin.wasm.writerprobe

import org.jetbrains.kotlin.wasm.ir.BoundedByteSink
import org.jetbrains.kotlin.wasm.ir.ByteWriterWithOffsetWrite
import org.jetbrains.kotlin.wasm.ir.WasmBinaryData.Companion.toByteArray

private class ObservableSink(limit: Int) : BoundedByteSink(limit) {
    fun bytes(): ByteArray = buf.copyOf(count)
    fun seek(offset: Int) { count = offset }
}

fun portableChecks(): String {
    val names = mutableListOf<String>()
    fun rejects(id: String, action: () -> Unit) {
        var rejected = false
        try { action() } catch (_: IllegalStateException) { rejected = true } catch (_: IllegalArgumentException) { rejected = true }
        check(rejected) { "Portable guard did not reject $id" }
        names += id
    }
    val sink = ObservableSink(4)
    sink.write(byteArrayOf(1, 2, 3))
    rejects("bulk-write-limit-before-mutation") { sink.write(byteArrayOf(4, 5)) }
    check(sink.bytes().contentEquals(byteArrayOf(1, 2, 3)))
    sink.write(0xff); check(sink.bytes().contentEquals(byteArrayOf(1, 2, 3, -1)))
    rejects("single-write-limit") { sink.write(1) }
    rejects("negative-input-offset") { sink.write(byteArrayOf(1), -1, 1) }
    rejects("oversized-input-range") { sink.write(byteArrayOf(1), 0, Int.MAX_VALUE) }
    rejects("negative-seek") { sink.seek(-1) }
    rejects("seek-past-limit") { sink.seek(5) }
    check(sink.bytes().contentEquals(byteArrayOf(1, 2, 3, -1)))
    rejects("negative-limit") { ObservableSink(-1) }
    val empty = ObservableSink(0); empty.write(byteArrayOf()); check(empty.size() == 0)
    rejects("zero-limit-write") { empty.write(1) }
    val writer = ByteWriterWithOffsetWrite(4)
    writer.writeBytes(byteArrayOf(1, 2, 3, 4))
    writer.writeUInt64(0xfedcuL, 2, 1)
    check(writer.getBinaryData().toByteArray().contentEquals(byteArrayOf(1, 0xdc.toByte(), 0xfe.toByte(), 4)))
    rejects("bounded-writer-append") { writer.writeByte(5) }
    rejects("bounded-writer-offset") { writer.writeUInt64(1uL, 1, Int.MAX_VALUE) }
    check(writer.written == 4)
    return names.joinToString(prefix = "{\"passed\":[", postfix = "],\"failed\":0}") { "\"$it\"" }
}
