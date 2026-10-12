/*
 * Copyright 2026 wasm-llvm contributors.
 * SPDX-License-Identifier: Apache-2.0
 */
package org.jetbrains.kotlin.portable.interning

/** The equality/hash strategy consumed by the pinned, complete IrInterningService. */
internal object Hash {
    interface Strategy<T> {
        fun hashCode(value: T?): Int
        fun equals(first: T?, second: T?): Boolean
    }
}

/** Only the canonical addOrGet/clear surface used by IrInterningService. */
internal class ObjectOpenCustomHashSet<T>(private val strategy: Hash.Strategy<T>) {
    private var keys = arrayOfNulls<Any>(32)
    private var mask = keys.lastIndex
    private var size = 0
    private var hasNullKey = false
    private var nullKey: T? = null

    fun addOrGet(value: T): T {
        if (strategy.equals(value, null)) {
            if (hasNullKey) return canonicalNullKey()
            hasNullKey = true
            nullKey = value
        } else {
            var position = mix(strategy.hashCode(value)) and mask
            while (true) {
                val current = keys[position] ?: break
                @Suppress("UNCHECKED_CAST")
                if (strategy.equals(current as T, value)) return current
                position = (position + 1) and mask
            }
            keys[position] = value
        }
        size++
        if (size > keys.size - keys.size / 4) rehash()
        return value
    }

    @Suppress("UNCHECKED_CAST")
    private fun canonicalNullKey(): T = nullKey as T

    private fun rehash() {
        check(keys.size <= (1 shl 29)) { "Interning set capacity exhausted" }
        val previous = keys
        keys = arrayOfNulls(previous.size * 2)
        mask = keys.lastIndex
        // Traverse backward, as Fastutil does, preserving the first canonical key.
        for (index in previous.lastIndex downTo 0) {
            val value = previous[index] ?: continue
            @Suppress("UNCHECKED_CAST")
            var position = mix(strategy.hashCode(value as T)) and mask
            while (keys[position] != null) position = (position + 1) and mask
            keys[position] = value
        }
    }

    fun clear() {
        if (size == 0) return
        keys.fill(null)
        size = 0
        hasNullKey = false
        nullKey = null
    }

    private fun mix(hash: Int): Int {
        val mixed = hash * -1640531527
        return mixed xor (mixed ushr 16)
    }
}

internal class ObjectOpenHashSet<T> {
    private val storage = ObjectOpenCustomHashSet(object : Hash.Strategy<T> {
        override fun hashCode(value: T?): Int = value?.hashCode() ?: 0
        override fun equals(first: T?, second: T?): Boolean = first == second
    })
    fun addOrGet(value: T): T = storage.addOrGet(value)
    fun clear() = storage.clear()
}
