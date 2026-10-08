/* Compiler-host UTF-8 boundary. Source provenance is recorded in sources.lock.json. */
package org.jetbrains.kotlin.portable.text

import kotlin.text.CharacterCodingException

/** The common equivalent of a JVM UTF-8 decoder's malformed-input result. */
class CompilerMalformedUtf8Exception(val inputLength: Int, val startIndex: Int) : CharacterCodingException() {
    override val message: String get() = "Input length = $inputLength"
}

/** Kotlin/JVM String.toByteArray() defaults, including one '?' per unpaired surrogate. */
fun String.compilerUtf8Bytes(): ByteArray = encodeUtf8(this, 0, length, false)

fun String.compilerUtf8Bytes(startIndex: Int, endIndex: Int, throwOnInvalidSequence: Boolean = false): ByteArray {
    checkTextBounds(startIndex, endIndex, length)
    return encodeUtf8(this, startIndex, endIndex, throwOnInvalidSequence)
}

/** Kotlin/JVM UTF-8 replacement grouping; strict mode rejects malformed input. */
fun ByteArray.compilerUtf8String(
    startIndex: Int = 0,
    endIndex: Int = size,
    throwOnInvalidSequence: Boolean = false,
): String {
    checkTextBounds(startIndex, endIndex, size)
    return decodeUtf8(this, startIndex, endIndex, throwOnInvalidSequence)
}

// Same bounds ordering and messages as the selected AbstractList.checkBoundsIndexes.
private fun checkTextBounds(startIndex: Int, endIndex: Int, size: Int) {
    if (startIndex < 0 || endIndex > size) {
        throw IndexOutOfBoundsException("startIndex: $startIndex, endIndex: $endIndex, size: $size")
    }
    if (startIndex > endIndex) {
        throw IllegalArgumentException("startIndex: $startIndex > endIndex: $endIndex")
    }
}
