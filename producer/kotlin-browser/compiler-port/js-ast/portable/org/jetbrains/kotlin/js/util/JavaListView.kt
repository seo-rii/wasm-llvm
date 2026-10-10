/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.util

/** Java List's read/mutate interface over a common readonly list, without copying its values. */
fun <T> asJavaMutableList(list: List<T>): MutableList<T> {
    if (list is MutableList<T>) return list
    return object : AbstractMutableList<T>() {
        override val size: Int get() = list.size
        override fun get(index: Int): T = list[index]
        override fun add(index: Int, element: T) { throw UnsupportedOperationException() }
        override fun set(index: Int, element: T): T { throw UnsupportedOperationException() }
        override fun removeAt(index: Int): T { throw UnsupportedOperationException() }
    }
}

/** Java Map callers can mutate a real mutable map and read a readonly map. */
fun <K, V> asJavaMutableMap(original: Map<K, V>): MutableMap<K, V> {
    if (original is MutableMap<K, V>) return original
    return object : AbstractMutableMap<K, V>() {
        override val size: Int get() = original.size
        override fun get(key: K): V? = original[key]
        override fun containsKey(key: K): Boolean = original.containsKey(key)
        override fun put(key: K, value: V): V? = throw UnsupportedOperationException()
        override fun putAll(from: Map<out K, V>) { throw UnsupportedOperationException() }
        override fun remove(key: K): V? = throw UnsupportedOperationException()
        override fun clear() { throw UnsupportedOperationException() }
        override val entries: MutableSet<MutableMap.MutableEntry<K, V>> = object : AbstractMutableSet<MutableMap.MutableEntry<K, V>>() {
            override val size: Int get() = original.size
            override fun add(element: MutableMap.MutableEntry<K, V>): Boolean = throw UnsupportedOperationException()
            override fun iterator(): MutableIterator<MutableMap.MutableEntry<K, V>> {
                val iterator = original.entries.iterator()
                return object : MutableIterator<MutableMap.MutableEntry<K, V>> {
                    override fun hasNext(): Boolean = iterator.hasNext()
                    override fun next(): MutableMap.MutableEntry<K, V> {
                        val entry = iterator.next()
                        return object : MutableMap.MutableEntry<K, V> {
                            override val key: K get() = entry.key
                            override val value: V get() = entry.value
                            override fun setValue(newValue: V): V = throw UnsupportedOperationException()
                            override fun equals(other: Any?): Boolean = other is Map.Entry<*, *> && key == other.key && value == other.value
                            override fun hashCode(): Int = (key?.hashCode() ?: 0) xor (value?.hashCode() ?: 0)
                        }
                    }
                    override fun remove() { throw UnsupportedOperationException() }
                }
            }
        }
    }
}
