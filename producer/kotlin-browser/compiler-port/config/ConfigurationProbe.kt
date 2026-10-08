@file:OptIn(org.jetbrains.kotlin.config.CompilerConfiguration.Internals::class)
package org.jetbrains.kotlin.portable.configcheck

import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.config.CompilerConfigurationKey

private class Bag<T>(val items: MutableList<T>) : Collection<T> by items

@Suppress("UNCHECKED_CAST")
fun observeConfiguration(): String {
    val observations = ArrayList<String>()
    fun record(name: String, value: Any?) { observations += "$name=$value" }
    fun denied(name: String, operation: () -> Unit) {
        try { operation(); record(name, "allowed") }
        catch (_: UnsupportedOperationException) { record(name, "unsupported") }
    }
    fun readOnly(name: String, operation: () -> Unit) {
        try { operation(); record(name, "allowed") }
        catch (error: IllegalStateException) { record(name, error.message) }
    }
    val configuration = CompilerConfiguration()
    val first = CompilerConfigurationKey.create<Int>("same")
    val second = CompilerConfigurationKey.create<Int>("same")
    configuration.put(first, 1); configuration.put(second, 2)
    record("identity", "${configuration[first]},${configuration[second]}")
    record("name", first.toString())
    val missing = CompilerConfigurationKey.create<String>("missing")
    record("absent", configuration[missing])
    record("default", configuration[missing, "default"])
    var calls = 0
    record("lazyDefault", configuration.getOrDefault(missing) { calls++; "lazy" })
    configuration.put(missing, "present")
    record("presentDefault", configuration.getOrDefault(missing) { calls++; "wrong" })
    record("defaultCalls", calls)
    record("notNull", configuration.getNotNull(missing))
    record("putIfAbsent", configuration.putIfAbsent(missing, "different"))
    configuration.putIfNotNull(missing, null)
    record("nullIgnored", configuration[missing])

    val listKey = CompilerConfigurationKey.create<List<Int>>("list")
    val list = mutableListOf(1, 2, 3)
    configuration.put(listKey, list)
    val view = configuration[listKey]!! as MutableList<Int>
    val raw = configuration.getList(listKey)
    record("defaultOverloadIdentity", raw === list)
    val iterator = view.iterator()
    val listIterator = view.listIterator()
    val subList = view.subList(0, 2)
    denied("iteratorBeforeNext") { iterator.remove() }
    denied("listIteratorBeforeNext") { listIterator.remove() }
    denied("listIteratorSet") { listIterator.set(10) }
    denied("listIteratorAdd") { listIterator.add(10) }
    denied("listAdd") { view.add(4) }
    denied("listAddAllEmpty") { view.addAll(emptyList()) }
    denied("listInsert") { view.add(0, 4) }
    denied("listInsertAllEmpty") { view.addAll(0, emptyList()) }
    denied("listSet") { view[0] = 4 }
    denied("listRemoveAbsent") { view.remove(99) }
    denied("listRemoveAt") { view.removeAt(0) }
    denied("listRemoveAllEmpty") { view.removeAll(emptyList()) }
    denied("listRetainAll") { view.retainAll(listOf(1, 2, 3)) }
    denied("listClear") { view.clear() }
    denied("subListClear") { subList.clear() }
    list[0] = 7
    record("liveList", view)
    record("liveSubList", subList)
    record("listEqual", view == list)
    record("listHash", view.hashCode() == list.hashCode())
    configuration.add(listKey, 4)
    configuration.addAll(listKey, 1, listOf(5, 6))
    configuration.addAll(listKey, listOf(8, 9))
    record("liveAdds", view)

    val mapKey = CompilerConfigurationKey.create<Map<String, Int?>>("map")
    val map = linkedMapOf<String, Int?>("a" to 1, "null" to null)
    configuration.put(mapKey, map)
    val mapView = configuration[mapKey]!! as MutableMap<String, Int?>
    val keys = mapView.keys; val values = mapView.values; val entries = mapView.entries
    val entry = entries.first { it.key == "a" }
    record("rawMapIdentity", configuration.getMap(mapKey) === map)
    denied("mapPut") { mapView["b"] = 2 }
    denied("mapPutAllEmpty") { mapView.putAll(emptyMap()) }
    denied("mapRemoveMissing") { mapView.remove("none") }
    denied("mapClear") { mapView.clear() }
    denied("mapEntrySet") { entry.setValue(99) }
    denied("mapEntriesClear") { entries.clear() }
    denied("mapEntriesIteratorRemove") { entries.iterator().remove() }
    denied("mapKeysClear") { keys.clear() }
    denied("mapValuesClear") { values.clear() }
    denied("mapKeysIteratorRemove") { keys.iterator().remove() }
    denied("mapValuesIteratorRemove") { values.iterator().remove() }
    record("entryBeforeMutation", entry)
    map["a"] = 3; configuration.put(mapKey, "b", 4)
    record("liveMap", mapView)
    // Map.Entry references are only defined during iteration without external
    // backing-map modification. Reiterate the live entry-set after mutation.
    record("freshEntry", entries.first { it.key == "a" })
    record("liveKeys", keys)
    record("liveValues", values)
    record("liveEntries", entries)
    record("mapEqual", mapView == map)
    record("mapHash", mapView.hashCode() == map.hashCode())

    val setKey = CompilerConfigurationKey.create<Set<String>>("set")
    val set = linkedSetOf("x")
    configuration.put(setKey, set)
    val setView = configuration[setKey]!! as MutableSet<String>
    denied("setAdd") { setView.add("x") }
    denied("setRemoveMissing") { setView.remove("none") }
    denied("setIteratorRemove") { setView.iterator().remove() }
    set += "y"
    record("liveSet", setView)
    record("setEqual", setView == set)
    record("setHash", setView.hashCode() == set.hashCode())
    record("rawSetIdentity", configuration.getSet(setKey) === set)

    val bagKey = CompilerConfigurationKey.create<Collection<Int>>("bag")
    val bag = Bag(mutableListOf(1))
    configuration.put(bagKey, bag)
    val bagView = configuration[bagKey]!! as MutableCollection<Int>
    denied("bagAddAllEmpty") { bagView.addAll(emptyList()) }
    denied("bagClear") { bagView.clear() }
    denied("bagIteratorRemove") { bagView.iterator().remove() }
    bag.items += 2
    record("liveBag", bagView.joinToString())
    record("bagEqualityIdentity", bagView == bagView)
    record("bagValueEqualityAbsent", bagView == configuration[bagKey])

    val copy = configuration.copy()
    record("shallowCopyList", copy.getList(listKey) === list)
    copy.add(listKey, 10)
    record("sharedCopyMutation", view.last())
    configuration.isReadOnly = true
    record("existingPutIfAbsentReadOnly", configuration.putIfAbsent(missing, "unused"))
    readOnly("readOnlyPut") { configuration.put(first, 99) }
    readOnly("readOnlyAdd") { configuration.add(listKey, 99) }
    readOnly("readOnlyAddAllEmpty") { configuration.addAll(listKey, emptyList()) }
    readOnly("readOnlyMapPut") { configuration.put(mapKey, "c", 99) }
    record("copyIsWritable", !copy.isReadOnly)
    record("format", copy.toString(setOf(first)) {
        if (it is Bag<*>) it.items.joinToString(prefix = "bag[", postfix = "]") else it.toString()
    }.replace("\n", "|"))
    record("originalIdentityAfterCopy", "${configuration[first]},${configuration[second]}")
    return observations.joinToString("\n")
}

/** Record host behavior that Java deliberately leaves undefined; do not count it as equivalent. */
fun observeStaleEntry(): String {
    val configuration = CompilerConfiguration()
    val key = CompilerConfigurationKey.create<Map<String, Int>>("map")
    val map = linkedMapOf("a" to 1)
    configuration.put(key, map)
    val entry = configuration[key]!!.entries.first()
    map["b"] = 2
    return try { entry.toString() } catch (_: ConcurrentModificationException) { "ConcurrentModificationException" }
}
