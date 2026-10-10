package org.jetbrains.kotlin.js.outputprobe

private fun ByteArray.hex(): String = joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }

fun observation(): String {
    val records = mutableListOf<String>()
    fun record(name: String, action: (ProbeDataWriter) -> Unit) {
        val writer = ProbeDataWriter()
        action(writer)
        records += name + ":" + writer.data.toByteArray().hex()
    }
    for (byte in -129..256) {
        val writer = ProbeDataWriter()
        val failure = try { writer.writeByte(byte); "ok" } catch (error: IllegalStateException) { error.message!! }
        records += "byte-$byte:$failure:" + writer.data.toByteArray().hex()
    }
    val ints = listOf(Int.MIN_VALUE, Int.MAX_VALUE, -1, 0, 1, 127, 128, 255, 256, -256)
    for (int in ints) record("int-$int") { it.writeInt(int) }
    record("bools") { it.writeBoolean(false); it.writeBoolean(true) }
    val special = listOf(0L, Long.MIN_VALUE, 1L, -1L, 0x7ff0000000000000L, -0x0010000000000000L,
        0x7ff0000000000001L, 0x7ff8000000000000L, 0x7fffffffffffffffL, -0x000fffffffffffffL,
        0x0010000000000000L, 0x000fffffffffffffL)
    for ([index, bits] in special.withIndex()) record("double-$index") { it.writeDouble(Double.fromBits(bits)) }
    var seed = 0x31415926
    repeat(2048) { index ->
        seed = seed * 1664525 + 1013904223
        val high = seed
        seed = seed * 1664525 + 1013904223
        val bits = (high.toLong() shl 32) or (seed.toLong() and 0xffffffffL)
        record("random-$index") { it.writeInt(high); it.writeDouble(Double.fromBits(bits)); it.writeBoolean(seed < 0) }
    }
    for (length in listOf(0, 1, 31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256, 257, 4096)) {
        record("array-$length") { writer ->
            val bytes = ByteArray(length) { (it * 71).toByte() }
            writer.writeByteArray(bytes)
            if (bytes.isNotEmpty()) bytes[0] = 99
            val snapshot = writer.data.toByteArray()
            if (snapshot.isNotEmpty()) snapshot[0] = 99
            writer.writeInt(length)
        }
    }
    val strings = listOf("", "ascii", "한글", "a\u0000b", "\ud800", "\udfff", "\ud800a\udfff", "\ud83d\ude00", "\ud800\ud800\udfff")
    for ([index, string] in strings.withIndex()) record("string-$index") { it.writeString(string) }
    for (code in 0..65535) {
        val writer = ProbeDataWriter(); writer.writeString(code.toChar().toString())
        records += "char-$code:" + writer.data.toByteArray().hex()
    }
    record("collection") { it.writeCollection(listOf(-1, 0, Int.MAX_VALUE), it::writeInt) }
    record("conditional") {
        it.ifNotNull<Int>(null, it::writeInt); it.ifNotNull(27, it::writeInt)
        it.ifTrue(false) { it.writeInt(-1) }; it.ifTrue(true) { it.writeInt(29) }
    }
    record("mutation-transfer") { destination ->
        val source = ProbeDataWriter(); source.writeString("first"); source.data.writeTo(destination.data)
        source.writeString("second"); transferSaved(source, destination)
        source.data.writeTo(source.data); source.data.writeTo(destination.data)
    }
    return "{\"records\":[" + records.joinToString(",") { "\"$it\"" } + "]}"
}
