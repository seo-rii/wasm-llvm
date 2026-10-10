package org.jetbrains.kotlin.js.astintegerprobe

fun boundsObservation(): String {
    val base = observation()
    val extra = ArrayList<String>()
    fun prefixed(length: Int, bytes: ByteArray) = ByteArray(4) { (length ushr (24 - it * 8)).toByte() } + bytes
    for (length in listOf(-1, Int.MIN_VALUE, Int.MAX_VALUE, 2, 8)) {
        val input = LiteralInput(prefixed(length, byteArrayOf(1)))
        var failure = "NO_EXCEPTION"
        try { input.transformed() } catch (error: Throwable) { failure = error::class.simpleName ?: "Throwable" }
        check(failure == "IllegalArgumentException" && input.calls == 0 && input.position() == 4)
        extra.add("length.$length=$failure/${input.calls}/${input.position()}")
    }
    for (length in listOf(0, 1, 4)) {
        val input = LiteralInput(prefixed(length, ByteArray(length)))
        check(input.transformed() == length && input.calls == 1 && input.position() == length + 4)
        extra.add("valid.$length=${input.calls}/${input.position()}")
    }
    return base.dropLast(1) + ",\"bounds\":[" + extra.joinToString(",") { "\"$it\"" } + "]}"
}
