/* Differential observer of actual pinned hash and serialized IR fingerprint bodies. */
package org.jetbrains.kotlin.backend.common.serialization.probe

import org.jetbrains.kotlin.backend.common.serialization.*
import org.jetbrains.kotlin.library.SerializedIrFile

private fun ByteArray.hex() = joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }
private fun data(size: Int, salt: Int = 0) = ByteArray(size) { ((it * 131 + salt * 17) xor (it ushr 3)).toByte() }

fun fingerprintsObservation(): String = buildString {
    fun record(id: String, value: String) { append(id).append('=').append(value).append('\n') }
    val lengths = listOf(0, 1, 3, 4, 7, 8, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256, 257, 1024, 4096)
    val seed = Hash128Bits(ULong.MAX_VALUE, 0x8000000000000000uL)
    for (size in lengths) {
        val bytes = data(size)
        record("hash-$size", "${cityHash64(bytes)}:${FingerprintHash(cityHash128(bytes))}:${FingerprintHash(cityHash128WithSeed(seed, bytes))}")
        val padded = data(size + 20); bytes.copyInto(padded, 9)
        record("offset-$size", "${cityHash64(padded, 9, size)}:${FingerprintHash(cityHash128(padded, 9, size))}:${FingerprintHash(cityHash128WithSeed(seed, padded, 9, size))}")
    }
    val words = listOf(0uL, 1uL, Long.MAX_VALUE.toULong(), 0x8000000000000000uL, ULong.MAX_VALUE, 0x0123456789abcdefuL)
    for (entry in words.withIndex()) {
        val index = entry.index; val low = entry.value
        val hash = FingerprintHash(Hash128Bits(low, words[words.lastIndex - index]))
        val bytes = hash.toByteArray(); check(bytes.size == 16); check(FingerprintHash.fromByteArray(bytes) == hash)
        record("words-$index", "$hash:${bytes.hex()}:${FingerprintHash.fromByteArray(bytes + data(19))}")
    }
    for (size in 0 until 16) {
        val value = try { FingerprintHash.fromByteArray(data(size)); "accepted" }
            catch (error: IndexOutOfBoundsException) { "bounds:${error.message}" }
        check(value.startsWith("bounds:")); record("short-$size", value)
    }
    for (entry in listOf("", ".", "0.0", "1.2", "!invalid!.1.2", "1.!invalid!.2", "1.2.!invalid!", "1.2.3", "1", "-1.2", "3w5e11264sgsf.3w5e11264sgsf", "3w5e11264sgsg.2").withIndex()) {
        val index = entry.index; val text = entry.value
        record("parse-$index", FingerprintHash.fromString(text)?.toString() ?: "null")
    }
    for (entry in listOf("", "abc", "한글", "\uD83D\uDE00", "\uD800", "\uDC00", "a\uD800b\uDC00c", "\uD800\uD800\uDC00").withIndex()) {
        val index = entry.index; val text = entry.value
        record("text-$index", "${text.cityHash64()}:${text.cityHash64String()}")
    }
    val files = (0 until 6).map { salt -> SerializedIrFile(data(129, salt), "real.name", "path-$salt", data(17, salt), data(31, salt),
        data(63, salt), data(128, salt), data(257, salt), null, if (salt % 2 == 0) data(32, salt) else null) }
    val fingerprints = files.map { SerializedIrFileFingerprint(it) }
    for (entry in fingerprints.withIndex()) { val index = entry.index; val hash = entry.value; check(SerializedIrFileFingerprint.fromString(hash.toString()) == hash); record("file-$index", hash.toString()) }
    for (entry in listOf(emptyList(), fingerprints, fingerprints.reversed(), fingerprints + fingerprints, fingerprints.drop(1)).withIndex()) {
        val index = entry.index; val hashes = entry.value
        val hash = SerializedKlibFingerprint(hashes); check(SerializedKlibFingerprint.fromString(hash.toString()) == hash); record("klib-$index", hash.toString())
    }
}
