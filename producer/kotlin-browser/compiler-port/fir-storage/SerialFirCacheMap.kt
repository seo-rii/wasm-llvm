/*
 * Copyright 2026 wasm-llvm contributors.
 * Licensed under the Apache License, Version 2.0.
 */

package org.jetbrains.kotlin.utils

/**
 * Cache operations used by the pinned FIR2IR and expect/actual storages in one
 * serial compiler Worker. This is not a ConcurrentMap or a MutableMap facade.
 * Keys retain their ordinary equality/hash semantics; neither keys nor values
 * may be null. The table, views and entries belong to this cache's real owner.
 *
 * The backed read-only views have weak iterators: each iterator prefetches its
 * next entry node and reads current values when visited. Appends can become
 * visible before the last node is returned; later appends can be omitted. This
 * is an allowed weak traversal, with no ordering promise or fail-fast iterator.
 * No selected consumer removes entries or mutates Map collection views.
 */
class SerialFirCacheMap<K, V> : AbstractMap<K, V>() {
    private class Node<K, V>(val key: K, var value: V)

    private val table = HashMap<K, Node<K, V>>()
    private val nodes = ArrayList<Node<K, V>>()
    private var computing = false

    override val size: Int get() = table.size
    override fun isEmpty(): Boolean = table.isEmpty()

    private fun requireKey(key: K) {
        if (key == null) throw NullPointerException()
    }

    private fun requireValue(value: V) {
        if (value == null) throw NullPointerException()
    }

    private fun requireWriteAllowed() {
        // The actual compute callbacks only construct a storage or a new map.
        // Like ConcurrentHashMap's documented callback contract, updating this
        // cache from its mapping callback is forbidden. Read-only reentry works.
        if (computing) throw IllegalStateException("Recursive update")
    }

    override operator fun get(key: K): V? {
        requireKey(key)
        return table[key]?.value
    }

    override fun containsKey(key: K): Boolean {
        requireKey(key)
        return table.containsKey(key)
    }

    override fun containsValue(value: V): Boolean {
        requireValue(value)
        return nodes.any { it.value == value }
    }

    private fun insert(key: K, value: V) {
        val node = Node(key, value)
        table[key] = node
        nodes.add(node)
    }

    fun put(key: K, value: V): V? {
        requireKey(key)
        requireValue(value)
        requireWriteAllowed()
        val node = table[key]
        if (node == null) {
            insert(key, value)
            return null
        }
        val previous = node.value
        node.value = value
        return previous
    }

    operator fun set(key: K, value: V) {
        put(key, value)
    }

    fun putAll(from: Map<out K, V>) {
        for ([key, value] in from) put(key, value)
    }

    fun putIfAbsent(key: K, value: V): V? {
        requireKey(key)
        requireValue(value)
        requireWriteAllowed()
        val node = table[key]
        if (node != null) return node.value
        insert(key, value)
        return null
    }

    /** Kotlin's ConcurrentMap getOrPut: a reentrant insertion wins. */
    inline fun getOrPut(key: K, defaultValue: () -> V): V {
        return get(key) ?: defaultValue().let { value -> putIfAbsent(key, value) ?: value }
    }

    /**
     * Null results are not installed, exceptions release the reservation for a
     * later retry, and same-cache write reentry is rejected. This intentionally
     * does not emulate JDK bin-specific behavior for callbacks violating its
     * no-map-update contract; no selected compute callback performs such writes.
     */
    fun computeIfAbsent(key: K, mappingFunction: (K) -> V): V {
        requireKey(key)
        val existing = table[key]
        if (existing != null) return existing.value
        requireWriteAllowed()
        computing = true
        try {
            val result = mappingFunction(key)
            if (result != null) insert(key, result)
            return result
        } finally {
            computing = false
        }
    }

    private fun <T> iterator(project: (Node<K, V>) -> T): Iterator<T> = object : Iterator<T> {
        private var nextIndex = 0
        private var nextNode: Node<K, V>? = nodes.firstOrNull()
        override fun hasNext(): Boolean = nextNode != null
        override fun next(): T {
            val current = nextNode ?: throw NoSuchElementException()
            // JDK weak iterators advance before returning the current entry.
            // Declaration generation between next() calls can append another
            // entry. Once advance reaches the end, the iterator stays ended.
            nextNode = nodes.getOrNull(++nextIndex)
            return project(current)
        }
    }

    private class Entry<K, V>(override val key: K, override val value: V) : Map.Entry<K, V> {
        override fun equals(other: Any?): Boolean = other is Map.Entry<*, *> && key == other.key && value == other.value
        override fun hashCode(): Int = (key?.hashCode() ?: 0) xor (value?.hashCode() ?: 0)
        override fun toString(): String = "$key=$value"
    }

    override val entries: Set<Map.Entry<K, V>> = object : AbstractSet<Map.Entry<K, V>>() {
        override val size: Int get() = this@SerialFirCacheMap.size
        override fun iterator(): Iterator<Map.Entry<K, V>> = iterator { Entry(it.key, it.value) }
        override fun contains(element: Map.Entry<K, V>): Boolean =
            element.key != null && element.value != null && table[element.key]?.value == element.value
    }

    override val keys: Set<K> = object : AbstractSet<K>() {
        override val size: Int get() = this@SerialFirCacheMap.size
        override fun iterator(): Iterator<K> = iterator { it.key }
        override fun contains(element: K): Boolean = containsKey(element)
    }

    override val values: Collection<V> = object : AbstractCollection<V>() {
        override val size: Int get() = this@SerialFirCacheMap.size
        override fun iterator(): Iterator<V> = iterator { it.value }
        override fun contains(element: V): Boolean = containsValue(element)
    }
}
