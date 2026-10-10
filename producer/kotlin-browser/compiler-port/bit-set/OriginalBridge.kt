package org.jetbrains.kotlin.portable.bits.probe

typealias SelectedBitSet = java.util.BitSet

fun observeNegativeSize(): String = try {
    SelectedBitSet(-1)
    "missing-failure"
} catch (e: NegativeArraySizeException) { "negative-size:${e.message}" }
