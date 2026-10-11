package org.jetbrains.kotlin.portable.predicate

/** The read/insert surface used by the pinned FIR predicate provider, not a general Guava replacement. */
internal interface Multimap<K, V> {
    operator fun get(key: K): Collection<V>
    fun put(key: K, value: V): Boolean
    fun putAll(key: K, values: Iterable<V>): Boolean
}

internal class LinkedHashMultimap<K, V> private constructor() : Multimap<K, V> {
    private val valuesByKey = linkedMapOf<K, MutableSet<V>>()

    // Guava get() is a live view even if the key has no values yet. No caller mutates this view.
    override fun get(key: K): Collection<V> = object : AbstractCollection<V>() {
        override val size: Int get() = valuesByKey[key]?.size ?: 0
        override fun iterator(): Iterator<V> = valuesByKey[key]?.iterator() ?: emptyList<V>().iterator()
        override fun contains(element: V): Boolean = valuesByKey[key]?.contains(element) ?: false
    }

    override fun put(key: K, value: V): Boolean = valuesByKey.getOrPut(key) { linkedSetOf() }.add(value)

    override fun putAll(key: K, values: Iterable<V>): Boolean {
        var changed = false
        for (value in values) if (put(key, value)) changed = true
        return changed
    }

    companion object {
        fun <K, V> create(): LinkedHashMultimap<K, V> = LinkedHashMultimap()
    }
}
