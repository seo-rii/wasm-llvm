package org.jetbrains.kotlin.portable.klib

/** SHA-256 for immutable KLIB file verification. Expected digests still come from the host's approved asset index. */
fun klibSha256(bytes: ByteArray): String {
    val state = intArrayOf(0x6a09e667, 0xbb67ae85.toInt(), 0x3c6ef372, 0xa54ff53a.toInt(),
        0x510e527f, 0x9b05688c.toInt(), 0x1f83d9ab, 0x5be0cd19)
    val words = IntArray(64)
    val total = ((bytes.size.toLong() + 9 + 63) / 64) * 64
    val bitLength = bytes.size.toLong() * 8
    fun encodedByte(position: Long): Int = when {
        position < bytes.size -> bytes[position.toInt()].toInt() and 255
        position == bytes.size.toLong() -> 128
        position >= total - 8 -> ((bitLength ushr ((total - 1 - position).toInt() * 8)) and 255).toInt()
        else -> 0
    }
    fun rotate(value: Int, count: Int): Int = (value ushr count) or (value shl (32 - count))
    var block = 0L
    while (block < total) {
        for (index in 0 until 16) {
            val start = block + index * 4
            words[index] = (encodedByte(start) shl 24) or (encodedByte(start + 1) shl 16) or
                (encodedByte(start + 2) shl 8) or encodedByte(start + 3)
        }
        for (index in 16 until 64) {
            val x = words[index - 15]
            val y = words[index - 2]
            val s0 = rotate(x, 7) xor rotate(x, 18) xor (x ushr 3)
            val s1 = rotate(y, 17) xor rotate(y, 19) xor (y ushr 10)
            words[index] = words[index - 16] + s0 + words[index - 7] + s1
        }
        var a = state[0]; var b = state[1]; var c = state[2]; var d = state[3]
        var e = state[4]; var f = state[5]; var g = state[6]; var h = state[7]
        for (index in 0 until 64) {
            val upper = rotate(e, 6) xor rotate(e, 11) xor rotate(e, 25)
            val choice = (e and f) xor (e.inv() and g)
            val first = h + upper + choice + SHA256_ROUND_CONSTANTS[index] + words[index]
            val lower = rotate(a, 2) xor rotate(a, 13) xor rotate(a, 22)
            val majority = (a and b) xor (a and c) xor (b and c)
            val second = lower + majority
            h = g; g = f; f = e; e = d + first
            d = c; c = b; b = a; a = first + second
        }
        state[0] += a; state[1] += b; state[2] += c; state[3] += d
        state[4] += e; state[5] += f; state[6] += g; state[7] += h
        block += 64
    }
    return state.joinToString("") { it.toUInt().toString(16).padStart(8, '0') }
}

private val SHA256_ROUND_CONSTANTS = listOf(
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
).map { it.toInt() }.toIntArray()
