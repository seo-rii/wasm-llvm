/* One observer for actual original signed integer literals and the common binding. */
package org.jetbrains.kotlin.js.astintegerprobe

private fun ByteArray.hex(): String = joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }
private fun prefixed(payload: ByteArray, length: Int = payload.size): ByteArray {
    return ByteArray(4) { (length ushr (24 - it * 8)).toByte() } + payload
}
private fun quote(text: String): String = buildString {
    append('"')
    for (char in text) when (char) {
        '\\' -> append("\\\\"); '"' -> append("\\\""); '\n' -> append("\\n"); '\r' -> append("\\r"); '\t' -> append("\\t")
        else -> if (char.code < 32) append("\\u" + char.code.toString(16).padStart(4, '0')) else append(char)
    }
    append('"')
}
fun observation(): String {
    val records = ArrayList<String>(); val failures = ArrayList<String>()
    fun record(name: String, value: Any?) { records.add("$name=$value") }
    val vectors = ArrayList<ByteArray>()
    for (value in 0..255) vectors.add(byteArrayOf(value.toByte()))
    for (size in listOf(2, 3, 4, 8, 16, 32, 64)) {
        vectors.add(ByteArray(size)); vectors.add(ByteArray(size) { -1 });
        vectors.add(ByteArray(size) { if (it == 0) 0 else -1 });
        vectors.add(ByteArray(size) { if (it == 0) -1 else 0 });
    }
    var state = 0x12345678
    repeat(256) { index ->
        vectors.add(ByteArray(index % 97 + 1) { state = state xor (state shl 13); state = state xor (state ushr 17); state = state xor (state shl 5); state.toByte() })
    }
    for (item in vectors.withIndex()) {
        val index = item.index; val bytes = item.value
        val input = LiteralInput(prefixed(bytes)); val literal = input.literal()
        val encoded = LiteralWriter().literal(literal)
        check(encoded[0].toInt() == 25)
        val decoded = LiteralInput(encoded.copyOfRange(1, encoded.size)); val copied = decoded.literal()
        record("vector.$index.decimal", literal.value.toString())
        record("vector.$index.bytes", literal.value.toByteArray().hex())
        record("vector.$index.serialized", encoded.hex())
        record("vector.$index.roundtrip", copied.value == literal.value)
        record("vector.$index.position", "${input.position()}/${decoded.position()}")
    }
    val malformed = listOf(
        byteArrayOf(), byteArrayOf(0), byteArrayOf(0, 0), byteArrayOf(0, 0, 0),
        prefixed(byteArrayOf(), 0), prefixed(byteArrayOf(), -1), prefixed(byteArrayOf(1), 2),
        prefixed(byteArrayOf(1), Int.MAX_VALUE), prefixed(byteArrayOf(1), Int.MIN_VALUE)
    )
    for (item in malformed.withIndex()) {
        val index = item.index; val bytes = item.value
        val input = LiteralInput(bytes)
        try { input.literal(); record("malformed.$index.failure", "NO_EXCEPTION") }
        catch (error: Throwable) { record("malformed.$index.failure", failureCategory(error)); failures.add("$index:${error::class.simpleName}:${error.message}") }
        record("malformed.$index.position", input.position())
    }
    return "{\"records\":[" + records.joinToString(",") { quote(it) } + "],\"failures\":[" + failures.joinToString(",") { quote(it) } + "]}"
}
