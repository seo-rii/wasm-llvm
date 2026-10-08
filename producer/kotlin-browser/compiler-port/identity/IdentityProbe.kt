package org.jetbrains.kotlin.portable.identityprobe

import org.jetbrains.kotlin.utils.SmartIdentityTable

private class EqualKey(val id: Int) {
    override fun equals(other: Any?): Boolean = other is EqualKey && id % 4 == other.id % 4
    override fun hashCode(): Int = 0
    override fun toString(): String = "key-$id"
}

private class PoisonKey {
    override fun equals(other: Any?): Boolean = error("Identity index invoked key equals")
    override fun hashCode(): Int = error("Identity index invoked key hashCode")
    override fun toString(): String = "poison"
}

private fun exceptionName(block: () -> Unit): String = try {
    block()
    "none"
} catch (_: ConcurrentModificationException) {
    "ConcurrentModificationException"
} catch (_: NoSuchElementException) {
    "NoSuchElementException"
} catch (_: IllegalArgumentException) {
    "IllegalArgumentException"
}

/** Observes the exact used API, canonicalizing only unspecified index iteration order. */
fun identityProbe(): String = buildString {
    fun record(id: String, value: Any?) { append(id).append('\t').append(value).append('\n') }
    val keys: List<Any?> = buildList {
        add(null)
        for (index in 0 until 64) add(EqualKey(index))
        add(PoisonKey())
        add(PoisonKey())
        // Equal string values made at runtime, retained as distinct identity keys.
        for (index in 0 until 2) add(buildString { append("runtime-string-"); append(keysSuffix()) })
    }
    fun label(key: Any?): String = keys.indexOfFirst { it === key }.let { if (it < 0) "absent" else it.toString() }
    fun snapshot(index: ProbeIndex<Any?, Any?>): String =
        index.map { entry -> label(entry.key) + "=" + entry.value }.sorted().joinToString(";")

    val index = ProbeIndex<Any?, Any?>()
    record("index-empty", index.isEmpty())
    record("index-negative-capacity", exceptionName { ProbeIndex<Any?, Any?>(-1) })
    record("index-absent-get", index[keys[1]])
    record("index-absent-contains", index.containsKey(keys[1]))
    record("index-absent-get-value", exceptionName { index.getValue(keys[1]) })
    record("index-null-key-put", index.put(null, "null-key"))
    record("index-null-key-get", index[null])
    record("index-null-key-replace", index.put(null, null))
    record("index-null-key-present", index.containsKey(null))
    record("index-null-key-get-value", index.getValue(null))
    record("index-empty-after-null", index.isEmpty())
    record("index-null-key-size", index.size)
    for ([keyIndex, key] in keys.withIndex()) {
        record("index-insert-$keyIndex", index.put(key, if (keyIndex % 3 == 0) null else "value-$keyIndex"))
        record("index-size-$keyIndex", index.size)
        record("index-get-$keyIndex", index[key])
    }
    record("index-all-entries", snapshot(index))
    record("index-reference-key-count", index.size == keys.size)
    for (keyIndex in keys.indices) record("index-present-$keyIndex", index.containsKey(keys[keyIndex]))
    val equalButAbsent = EqualKey(0)
    record("index-equal-absent-get", index[equalButAbsent])
    record("index-equal-absent-contains", index.containsKey(equalButAbsent))
    record("index-equal-absent-get-value", exceptionName { index.getValue(equalButAbsent) })
    record("index-missing-message", try { index.getValue("missing"); "no-error" } catch (e: NoSuchElementException) { e.message })

    var seed = 0x01234567
    repeat(2048) { iteration ->
        seed = seed * 1664525 + 1013904223
        val keyIndex = (seed ushr 1) % keys.size
        val value: Any? = if (iteration % 7 == 0) null else "mutation-$iteration"
        record("index-mutation-old-$iteration", index.put(keys[keyIndex], value))
        record("index-mutation-get-$iteration", index.getValue(keys[keyIndex]))
        record("index-mutation-size-$iteration", index.size)
        if (iteration % 32 == 0) record("index-mutation-entries-$iteration", snapshot(index))
    }
    record("index-final-entries", snapshot(index))

    val iteratorIndex = ProbeIndex<Any?, Any?>()
    val iteratorKey = PoisonKey()
    iteratorIndex[iteratorKey] = "before"
    val overwrittenIterator = iteratorIndex.iterator()
    iteratorIndex[iteratorKey] = "after"
    record("iterator-overwrite-has-next", overwrittenIterator.hasNext())
    val entry = overwrittenIterator.next()
    record("iterator-overwrite-key-identity", entry.key === iteratorKey)
    record("iterator-overwrite-value", entry.value)
    record("iterator-exhaustion-has-next", overwrittenIterator.hasNext())
    record("iterator-exhaustion-next", exceptionName { overwrittenIterator.next() })
    val invalidated = iteratorIndex.iterator()
    iteratorIndex[PoisonKey()] = "new-key"
    record("iterator-structural-modification", exceptionName { invalidated.next() })

    val table = SmartIdentityTable<Any?, Any?>()
    record("smart-empty", table.size)
    for ([keyIndex, key] in keys.withIndex()) {
        record("smart-insert-$keyIndex", table.set(key, if (keyIndex % 5 == 0) null else "smart-$keyIndex"))
        record("smart-size-$keyIndex", table.size)
        record("smart-get-$keyIndex", table[key])
    }
    for ([keyIndex, key] in keys.withIndex()) record("smart-overwrite-$keyIndex", table.set(key, "replaced-$keyIndex"))
    record("smart-repeated-identity-size", table.size)
    record("smart-equal-distinct-miss", table[EqualKey(0)])
    var calls = 0
    val nullTable = SmartIdentityTable<Any?, Any?>()
    repeat(3) { iteration ->
        record("smart-null-factory-result-$iteration", nullTable.getOrCreate(null) { calls++; null })
        record("smart-null-factory-calls-$iteration", calls)
        record("smart-null-factory-size-$iteration", nullTable.size)
    }
    val cached = PoisonKey()
    record("smart-non-null-factory-result", nullTable.getOrCreate(cached) { calls++; "cached" })
    record("smart-non-null-factory-hit", nullTable.getOrCreate(cached) { calls++; error("Factory must not run") })
    record("smart-non-null-factory-calls", calls)
    // Repeat the null factory case after the official >10 backing-store transition.
    for (key in keys.drop(1).take(16)) nullTable[key] = "warm"
    record("smart-large-null-factory-result", nullTable.getOrCreate(null) { calls++; null })
    record("smart-large-null-factory-calls", calls)
    record("smart-large-null-factory-size", nullTable.size)
}

private fun keysSuffix(): Int = 47
