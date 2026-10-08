package org.jetbrains.kotlin.portable.text.probe

import java.nio.ByteBuffer
import java.nio.charset.MalformedInputException

fun probeEncode(text: String): ByteArray = text.toByteArray()
fun probeEncodeRange(text: String, start: Int, end: Int): ByteArray = text.encodeToByteArray(start, end)
fun probeDecode(bytes: ByteArray, start: Int = 0, end: Int = bytes.size): String = bytes.decodeToString(start, end)

fun probeStrictDecode(bytes: ByteArray, start: Int = 0, end: Int = bytes.size): String {
    val buffer = ByteBuffer.wrap(bytes, start, end - start)
    return try {
        // Exact strict decoder operation used by the selected WasmBinaryToIR.readString.
        "ok:" + textUnits(Charsets.UTF_8.newDecoder().decode(buffer).toString())
    } catch (failure: MalformedInputException) {
        "malformed:${failure.inputLength}@${buffer.position()}"
    }
}
