/* Compiler host adapters; original configuration operations remain upstream. */
package org.jetbrains.kotlin.portable.config

/** Each key has reference identity, even when its display name is repeated. */
class IdentityKey<T> private constructor(private val name: String) {
    override fun toString(): String = name
    companion object { fun <T> create(name: String): IdentityKey<T> = IdentityKey(name) }
}

private fun denied(): Nothing = throw UnsupportedOperationException()

private class ReadOnlyIterator<T>(private val source: Iterator<T>) : MutableIterator<T> {
    override fun hasNext() = source.hasNext()
    override fun next() = source.next()
    override fun remove(): Unit = denied()
}

private class ReadOnlyListIterator<T>(private val source: ListIterator<T>) : MutableListIterator<T> {
    override fun hasNext() = source.hasNext()
    override fun next() = source.next()
    override fun hasPrevious() = source.hasPrevious()
    override fun previous() = source.previous()
    override fun nextIndex() = source.nextIndex()
    override fun previousIndex() = source.previousIndex()
    override fun add(element: T): Unit = denied()
    override fun set(element: T): Unit = denied()
    override fun remove(): Unit = denied()
}

private open class ReadOnlyCollection<T>(protected val source: Collection<T>) : MutableCollection<T> {
    override val size get() = source.size
    override fun contains(element: T) = source.contains(element)
    override fun containsAll(elements: Collection<T>) = source.containsAll(elements)
    override fun isEmpty() = source.isEmpty()
    override fun iterator(): MutableIterator<T> = ReadOnlyIterator(source.iterator())
    override fun add(element: T): Boolean = denied()
    override fun addAll(elements: Collection<T>): Boolean = denied()
    override fun remove(element: T): Boolean = denied()
    override fun removeAll(elements: Collection<T>): Boolean = denied()
    override fun retainAll(elements: Collection<T>): Boolean = denied()
    override fun clear(): Unit = denied()
    // java.util.Collections.unmodifiableCollection deliberately uses identity
    // equality; list and set wrappers below preserve their value equality.
    override fun toString() = source.toString()
}

private class ReadOnlyList<T>(private val list: List<T>) : ReadOnlyCollection<T>(list), MutableList<T> {
    override fun get(index: Int) = list[index]
    override fun indexOf(element: T) = list.indexOf(element)
    override fun lastIndexOf(element: T) = list.lastIndexOf(element)
    override fun listIterator(): MutableListIterator<T> = ReadOnlyListIterator(list.listIterator())
    override fun listIterator(index: Int): MutableListIterator<T> = ReadOnlyListIterator(list.listIterator(index))
    override fun subList(fromIndex: Int, toIndex: Int): MutableList<T> = ReadOnlyList(list.subList(fromIndex, toIndex))
    override fun add(index: Int, element: T): Unit = denied()
    override fun addAll(index: Int, elements: Collection<T>): Boolean = denied()
    override fun set(index: Int, element: T): T = denied()
    override fun removeAt(index: Int): T = denied()
    override fun equals(other: Any?) = list == other
    override fun hashCode() = list.hashCode()
}

private class ReadOnlySet<T>(private val set: Set<T>) : ReadOnlyCollection<T>(set), MutableSet<T> {
    override fun equals(other: Any?) = set == other
    override fun hashCode() = set.hashCode()
}

private class ReadOnlyEntry<K, V>(private val entry: Map.Entry<K, V>) : MutableMap.MutableEntry<K, V> {
    override val key get() = entry.key
    override val value get() = entry.value
    override fun setValue(newValue: V): V = denied()
    override fun equals(other: Any?) = other is Map.Entry<*, *> && key == other.key && value == other.value
    override fun hashCode() = (key?.hashCode() ?: 0) xor (value?.hashCode() ?: 0)
    override fun toString() = "$key=$value"
}

private class ReadOnlyEntries<K, V>(private val entries: Set<Map.Entry<K, V>>) : MutableSet<MutableMap.MutableEntry<K, V>> {
    override val size get() = entries.size
    override fun isEmpty() = entries.isEmpty()
    override fun contains(element: MutableMap.MutableEntry<K, V>) = entries.contains(element)
    override fun containsAll(elements: Collection<MutableMap.MutableEntry<K, V>>) = entries.containsAll(elements)
    override fun iterator(): MutableIterator<MutableMap.MutableEntry<K, V>> {
        val source = entries.iterator()
        return object : MutableIterator<MutableMap.MutableEntry<K, V>> {
            override fun hasNext() = source.hasNext()
            override fun next(): MutableMap.MutableEntry<K, V> = ReadOnlyEntry(source.next())
            override fun remove(): Unit = denied()
        }
    }
    override fun add(element: MutableMap.MutableEntry<K, V>): Boolean = denied()
    override fun addAll(elements: Collection<MutableMap.MutableEntry<K, V>>): Boolean = denied()
    override fun remove(element: MutableMap.MutableEntry<K, V>): Boolean = denied()
    override fun removeAll(elements: Collection<MutableMap.MutableEntry<K, V>>): Boolean = denied()
    override fun retainAll(elements: Collection<MutableMap.MutableEntry<K, V>>): Boolean = denied()
    override fun clear(): Unit = denied()
    override fun equals(other: Any?) = entries == other
    override fun hashCode() = entries.hashCode()
    override fun toString() = entries.toString()
}

private class ReadOnlyMap<K, V>(private val source: Map<K, V>) : MutableMap<K, V> {
    override val size get() = source.size
    override fun isEmpty() = source.isEmpty()
    override fun containsKey(key: K) = source.containsKey(key)
    override fun containsValue(value: V) = source.containsValue(value)
    override fun get(key: K) = source[key]
    override val keys: MutableSet<K> get() = ReadOnlySet(source.keys)
    override val values: MutableCollection<V> get() = ReadOnlyCollection(source.values)
    override val entries: MutableSet<MutableMap.MutableEntry<K, V>> get() = ReadOnlyEntries(source.entries)
    override fun put(key: K, value: V): V? = denied()
    override fun putAll(from: Map<out K, V>): Unit = denied()
    override fun remove(key: K): V? = denied()
    override fun clear(): Unit = denied()
    override fun equals(other: Any?) = source == other
    override fun hashCode() = source.hashCode()
    override fun toString() = source.toString()
}

/** A live view, as in Collections.unmodifiable*: never a defensive snapshot. */
@Suppress("UNCHECKED_CAST")
fun <T> T.unmodifiableConfigurationValue(): T = when (this) {
    is List<*> -> ReadOnlyList(this)
    is Map<*, *> -> ReadOnlyMap(this)
    is Set<*> -> ReadOnlySet(this)
    is Collection<*> -> ReadOnlyCollection(this)
    else -> this
} as T
