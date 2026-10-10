package org.jetbrains.kotlin.portable.text.probe

import org.jetbrains.kotlin.portable.text.CompilerMalformedUtf8Exception
import org.jetbrains.kotlin.portable.text.compilerUtf8Bytes
import org.jetbrains.kotlin.portable.text.compilerUtf8String

fun probeEncode(text: String): ByteArray = text.compilerUtf8Bytes()
fun probeEncodeRange(text: String, start: Int, end: Int): ByteArray = text.compilerUtf8Bytes(start, end)
fun probeDecode(bytes: ByteArray, start: Int = 0, end: Int = bytes.size): String = bytes.compilerUtf8String(start, end)

fun probeStrictDecode(bytes: ByteArray, start: Int = 0, end: Int = bytes.size): String = try {
    "ok:" + textUnits(bytes.compilerUtf8String(start, end, true))
} catch (failure: CompilerMalformedUtf8Exception) {
    "malformed:${failure.inputLength}@${failure.startIndex}"
}
