/*
 * Copyright 2010-2019 JetBrains s.r.o. and Kotlin Programming Language contributors.
 * Copyright 2026 wasm-llvm contributors.
 * Use of this source code is governed by the Apache 2.0 license that can be found in the license/LICENSE.txt file.
 *
 * The reference comparison/search follows the pinned SmartIdentityTable.kt.
 * See sources.lock.json for the original source and the selected call sites.
 */

package org.jetbrains.kotlin.utils

/**
 * Per-owner reference index for the operations actually used by the compiler's
 * IR attribute merging and Wasm reference/type tables. This is deliberately an
 * index, with no MutableMap equality/hash or mutable collection-view contract.
 *
 * Keys, including null, are compared only with ===. Values may be null. Both
 * arrays belong to this index and disappear when its compiler owner disappears;
 * no object IDs or object references are stored in a global registry. Lookup is
 * linear in the number of entries. Iteration order is an implementation detail.
 */
class IdentityIndex<K, V>(expectedSize: Int = 0) : Iterable<IdentityIndex.Entry<K, V>> {
    private val keysArray: MutableList<K> = ArrayList(expectedSize)
    private val valuesArray: MutableList<V> = ArrayList(expectedSize)
    private var modificationCount: Int = 0

    val size: Int get() = keysArray.size

    fun isEmpty(): Boolean = keysArray.isEmpty()

    fun containsKey(key: K): Boolean = findIndex(key) >= 0

    operator fun get(key: K): V? {
        val index = findIndex(key)
        return if (index >= 0) valuesArray[index] else null
    }

    /** As in Map.getValue, a stored null is a value, rather than a missing key. */
    fun getValue(key: K): V {
        val index = findIndex(key)
        if (index < 0) throw NoSuchElementException("Key $key is missing in the map.")
        return valuesArray[index]
    }

    fun put(key: K, value: V): V? {
        val index = findIndex(key)
        if (index >= 0) {
            val previousValue = valuesArray[index]
            valuesArray[index] = value
            return previousValue
        }
        keysArray.add(key)
        valuesArray.add(value)
        modificationCount++
        return null
    }

    operator fun set(key: K, value: V) {
        put(key, value)
    }

    private fun findIndex(key: K): Int {
        for (index in keysArray.indices) {
            if (keysArray[index] === key) return index
        }
        return -1
    }

    class Entry<K, V> internal constructor(val key: K, val value: V) {
        operator fun component1(): K = key
        operator fun component2(): V = value
    }

    override fun iterator(): Iterator<Entry<K, V>> = object : Iterator<Entry<K, V>> {
        private var nextIndex = 0
        private val expectedModificationCount = modificationCount

        override fun hasNext(): Boolean = nextIndex < keysArray.size

        override fun next(): Entry<K, V> {
            if (expectedModificationCount != modificationCount) throw ConcurrentModificationException()
            if (!hasNext()) throw NoSuchElementException()
            val index = nextIndex++
            return Entry(keysArray[index], valuesArray[index])
        }
    }
}
