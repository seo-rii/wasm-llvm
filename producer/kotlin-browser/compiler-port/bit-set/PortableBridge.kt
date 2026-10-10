package org.jetbrains.kotlin.portable.bits.probe

import org.jetbrains.kotlin.portable.bits.NegativeBitSetSizeException

typealias SelectedBitSet = org.jetbrains.kotlin.portable.bits.BitSet

fun observeNegativeSize(): String = try {
    SelectedBitSet(-1)
    "missing-failure"
} catch (e: NegativeBitSetSizeException) { "negative-size:${e.message}" }
