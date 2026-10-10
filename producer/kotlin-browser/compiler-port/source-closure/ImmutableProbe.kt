@file:OptIn(kotlin.js.ExperimentalJsExport::class)
package org.jetbrains.kotlin.portable.closure.probe

import kotlin.js.JsExport
import kotlinx.collections.immutable.*

private data class CollidingKey(val number: Int) {
    override fun hashCode(): Int = 7
}

/** Persistent collection operations used by the real FIR checker/CFG state. */
@JsExport
fun immutableProbe(): String {
    var list: PersistentList<Int> = persistentListOf()
    repeat(4096) { list = list.add(it) }
    val originalList = list
    val listBuilder = list.builder()
    repeat(256) { listBuilder.removeAt(31) }
    listBuilder.add(32, -1)
    val listBranch = listBuilder.build()
    listBuilder[0] = -2
    val changedList = listBuilder.build()
    check(originalList.size == 4096 && originalList[0] == 0 && originalList[4095] == 4095)
    check(listBranch.size == 3841 && listBranch[0] == 0 && listBranch[31] == 287 && listBranch[32] == -1)
    check(changedList[0] == -2 && listBranch[0] == 0)

    var map: PersistentMap<CollidingKey, PersistentSet<Int>> = persistentMapOf()
    repeat(256) { map = map.put(CollidingKey(it), persistentSetOf(it, it + 1)) }
    val originalMap = map
    val mapBuilder = map.builder()
    repeat(128) { mapBuilder.remove(CollidingKey(it)) }
    val mapBranch = mapBuilder.build()
    mapBuilder[CollidingKey(255)] = persistentSetOf(-1)
    val changedMap = mapBuilder.build()
    check(originalMap.size == 256 && originalMap[CollidingKey(0)] == setOf(0, 1))
    check(mapBranch.size == 128 && mapBranch[CollidingKey(0)] == null)
    check(mapBranch[CollidingKey(255)] == setOf(255, 256) && changedMap[CollidingKey(255)] == setOf(-1))

    var set: PersistentSet<CollidingKey> = persistentSetOf()
    repeat(256) { set = set.add(CollidingKey(it)) }
    val originalSet = set
    set = set.mutate { values -> repeat(128) { values.remove(CollidingKey(it)) } }
    check(originalSet.size == 256 && set.size == 128)
    check(CollidingKey(0) in originalSet && CollidingKey(0) !in set && CollidingKey(255) in set)
    val ordered = listOf(3, 2, 3, 1).toPersistentSet()
    check(ordered.toList() == listOf(3, 2, 1))
    val converted = listOf(1, 2, 3).toPersistentList()
    check(converted == listOf(1, 2, 3) && converted.hashCode() == listOf(1, 2, 3).hashCode())
    return "list=${originalList.size},branch=${listBranch.size},map=${originalMap.size},mapBranch=${mapBranch.size},set=${originalSet.size},setBranch=${set.size},order=${ordered.joinToString()};snapshots=pass"
}
