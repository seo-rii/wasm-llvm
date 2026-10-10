package org.jetbrains.kotlin.js.inputprobe
private fun Long.bytes(): ByteArray = ByteArray(8) { (this ushr (56 - 8 * it)).toByte() }
private fun Int.bytes(): ByteArray = ByteArray(4) { (this ushr (24 - 8 * it)).toByte() }
private fun String.units(): String = map { it.code.toString(16).padStart(4, '0') }.joinToString("")
private fun quote(value: String): String = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
fun observation(): String {
    val records = ArrayList<String>(); val failures = ArrayList<String>()
    fun record(name: String, value: Any?) { records.add("$name=$value") }
    for (value in 0..255) { val input = ProbeInput(byteArrayOf(value.toByte())); record("byte.$value", "${input.readByte()}/${input.position}") }
    val ints = arrayListOf(Int.MIN_VALUE, Int.MAX_VALUE, -1, 0, 1, 0x12345678)
    var state = 0x12481924
    repeat(1024) { state = state xor (state shl 13); state = state xor (state ushr 17); state = state xor (state shl 5); ints.add(state) }
    for (item in ints.withIndex()) { val input = ProbeInput(byteArrayOf(7) + item.value.bytes() + byteArrayOf(8)); input.seek(1); record("int.${item.index}", "${input.readInt()}/${input.position}/${input.readByte()}") }
    val bits = arrayListOf(0L, Long.MIN_VALUE, 1L, 0x000fffffffffffffL, 0x0010000000000000L, 0x7fefffffffffffffL,
        0x7ff0000000000000L, -0x0010000000000000L, 0x7ff8000000000000L, 0x7ff0000000000001L, 0x7fffffffffffffffL, -1L)
    var longState = 0x124819241256L
    repeat(2048) { longState = longState xor (longState shl 13); longState = longState xor (longState ushr 7); longState = longState xor (longState shl 17); bits.add(longState) }
    for (item in bits.withIndex()) { val input = ProbeInput(item.value.bytes()); val value = input.readDouble(); record("double.${item.index}.raw", value.toRawBits().toString(16)); record("double.${item.index}.canonical", value.toBits().toString(16)); record("double.${item.index}.position", input.position) }
    for (size in 0..8) for (kind in 0..2) {
        val input = ProbeInput(ByteArray(size) { it.toByte() })
        try { when (kind) { 0 -> input.readByte(); 1 -> input.readInt(); else -> input.readDouble() }; record("underflow.$size.$kind", "ok/${input.position}") }
        catch (error: Throwable) { record("underflow.$size.$kind", "${inputFailure(error)}/${input.position}"); failures.add("$size.$kind:${error::class.simpleName}:${error.message}") }
    }
    val source = byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8); val alias = ProbeInput(source); source[1] = 99; alias.seek(1)
    record("shared.source", "${alias.readByte()}/${alias.position}")
    for (offset in listOf(-1, 9, Int.MIN_VALUE, Int.MAX_VALUE)) {
        try { alias.seek(offset); record("seek.$offset", "NO_EXCEPTION") } catch (error: Throwable) { record("seek.$offset", "${error::class.simpleName}/${alias.position}"); failures.add("seek.$offset:${error::class.simpleName}:${error.message}") }
    }
    alias.seek(8); record("seek.limit", alias.position); alias.seek(0); record("seek.zero", alias.readByte())
    val single = ByteArray(3)
    for (a in 0..255) { single[1] = a.toByte(); record("utf8.single.$a", ProbeInput(single).readUtf8(1, 1).units()) }
    val pair = ByteArray(4)
    for (a in 0..255) for (b in 0..255) { pair[1] = a.toByte(); pair[2] = b.toByte(); record("utf8.pair.${(a shl 8) or b}", ProbeInput(pair).readUtf8(1, 2).units()) }
    val triples = listOf(byteArrayOf(0xed.toByte(), 0xa0.toByte(), 0x80.toByte()), byteArrayOf(0xe0.toByte(), 0x80.toByte(), 0x80.toByte()), byteArrayOf(0xef.toByte(), 0xbb.toByte(), 0xbf.toByte()),
        byteArrayOf(0xf0.toByte(), 0x9f.toByte(), 0x98.toByte(), 0x80.toByte()), byteArrayOf(0xf4.toByte(), 0x90.toByte(), 0x80.toByte(), 0x80.toByte()), "한글\r\n😀".encodeToByteArray())
    for (item in triples.withIndex()) for (size in 0..item.value.size) record("utf8.slice.${item.index}.$size", ProbeInput(item.value).readUtf8(0, size).units())
    return "{\"records\":[" + records.joinToString(",") { quote(it) } + "],\"failures\":[" + failures.joinToString(",") { quote(it) } + "]}"
}
