package org.jetbrains.kotlin.portable.collectionsprobe

import org.jetbrains.kotlin.utils.DFS
import org.jetbrains.kotlin.utils.SmartList

private class EqualityNode(val id: Int, val label: String) {
    override fun equals(other: Any?): Boolean = other is EqualityNode && id == other.id
    override fun hashCode(): Int = 7
}

private class IdentitySet<E> : AbstractMutableSet<E>() {
    private val elements = mutableListOf<E>()
    override val size: Int get() = elements.size
    override fun iterator(): MutableIterator<E> = elements.iterator()
    override fun add(element: E): Boolean {
        if (elements.any { it === element }) return false
        elements.add(element)
        return true
    }
}

private fun failure(block: () -> Unit): String = try { block(); "none" } catch (error: Throwable) {
    when (error) {
        is ConcurrentModificationException -> "concurrent"
        is NoSuchElementException -> "exhausted"
        is IndexOutOfBoundsException -> "bounds"
        is IllegalStateException -> "state"
        else -> error::class.simpleName.orEmpty()
    }
}

private fun quoted(text: String): String = buildString {
    append('"')
    for (c in text) when (c) {
        '"' -> append("\\\"")
        '\\' -> append("\\\\")
        '\n' -> append("\\n")
        '\r' -> append("\\r")
        '\t' -> append("\\t")
        else -> if (c.code < 32) append("\\u" + c.code.toString(16).padStart(4, '0')) else append(c)
    }
    append('"')
}

/** Same observations against exact Java, portable JVM and portable Wasm sources. */
fun collectionsProbe(): String {
    val cases = mutableListOf<String>()
    val edges = mapOf(1 to listOf(2, 3), 2 to listOf(4), 3 to listOf(4), 4 to listOf(1))
    val neighbors = DFS.Neighbors<Int> { edges[it].orEmpty() }
    var events = mutableListOf<String>()
    val ordered = DFS.dfs(listOf(1, 3, 5), neighbors, object : DFS.AbstractNodeHandler<Int, String>() {
        override fun beforeChildren(current: Int): Boolean { events += "b$current"; return true }
        override fun afterChildren(current: Int) { events += "a$current" }
        override fun result(): String { events += "result"; return events.joinToString(",") }
    })
    cases += "dfs-order:$ordered"
    val visitedSet = hashSetOf<Int>()
    events = mutableListOf()
    val pruning = object : DFS.AbstractNodeHandler<Int, String>() {
        override fun beforeChildren(current: Int): Boolean { events += "b$current"; return current != 2 }
        override fun afterChildren(current: Int) { events += "a$current" }
        override fun result(): String = events.joinToString(",")
    }
    DFS.dfs(listOf(1), neighbors, DFS.VisitedWithSet(visitedSet), pruning)
    cases += "dfs-prune:${pruning.result()}:${visitedSet.sorted()}"
    val beforeRetry = events.size
    DFS.dfsFromNode(2, neighbors, DFS.VisitedWithSet(visitedSet), pruning)
    cases += "dfs-pruned-mark:${events.size == beforeRetry}"
    val predicateCalls = mutableListOf<Int>()
    val neighborCalls = mutableListOf<Int>()
    val any = DFS.ifAny(listOf(1, 5), DFS.Neighbors<Int> { neighborCalls += it; edges[it].orEmpty() }) { predicateCalls += it; it == 2 }
    cases += "dfs-any:$any:$predicateCalls:$neighborCalls"
    predicateCalls.clear()
    cases += "dfs-none:${DFS.ifAny(listOf(1), neighbors) { predicateCalls += it; false }}:$predicateCalls"
    val topological = DFS.topologicalOrder(listOf(1, 5), neighbors)
    cases += "dfs-topological:$topological"
    cases += "dfs-previsited:${DFS.topologicalOrder(listOf(1, 5), neighbors, DFS.VisitedWithSet(hashSetOf(4)))}"
    val nullableNeighbors = DFS.Neighbors<Int?> { node -> when (node) { null -> listOf(2); 2 -> listOf(null); else -> emptyList() } }
    val nullable = DFS.dfs(listOf<Int?>(null, 1), nullableNeighbors, object : DFS.NodeHandlerWithListResult<Int?, Int?>() {
        override fun afterChildren(current: Int?) { result.add(current) }
    })
    cases += "dfs-nullable:$nullable"
    val first = EqualityNode(1, "first")
    val alias = EqualityNode(1, "alias")
    val second = EqualityNode(2, "second")
    val objectNeighbors = DFS.Neighbors<EqualityNode> { node -> when { node === first -> listOf(alias); node === alias -> listOf(second); else -> emptyList() } }
    fun collect(visited: DFS.Visited<EqualityNode>): String = DFS.dfs(listOf(first), objectNeighbors, visited, object : DFS.NodeHandlerWithListResult<EqualityNode, String>() {
        override fun afterChildren(current: EqualityNode) { result.add(current.label) }
    }).joinToString(",")
    cases += "dfs-equality:${collect(DFS.VisitedWithSet())}"
    cases += "dfs-identity:${collect(DFS.VisitedWithSet(IdentitySet()))}"
    val visitedVoid = hashSetOf<Int>()
    DFS.dfsFromNode(1, neighbors, DFS.VisitedWithSet(visitedVoid))
    cases += "dfs-void:${visitedVoid.sorted()}"
    val fault = IllegalArgumentException("original-fault")
    val visitedFault = hashSetOf<Int>()
    events = mutableListOf()
    try {
        DFS.dfs(listOf(1), neighbors, DFS.VisitedWithSet(visitedFault), object : DFS.AbstractNodeHandler<Int, String>() {
            override fun beforeChildren(current: Int): Boolean { events += "b$current"; if (current == 2) throw fault; return true }
            override fun afterChildren(current: Int) { events += "a$current" }
            override fun result(): String { events += "result"; return "result" }
        })
    } catch (error: Throwable) { cases += "dfs-before-failure:${error === fault}:$events:${visitedFault.sorted()}" }
    events = mutableListOf()
    try {
        DFS.dfs(listOf(1), DFS.Neighbors<Int> { if (it == 2) throw fault; edges[it].orEmpty() }, object : DFS.AbstractNodeHandler<Int, String>() {
            override fun beforeChildren(current: Int): Boolean { events += "b$current"; return true }
            override fun afterChildren(current: Int) { events += "a$current" }
            override fun result(): String { events += "result"; return "result" }
        })
    } catch (error: Throwable) { cases += "dfs-neighbor-failure:${error === fault}:$events" }
    events = mutableListOf()
    try {
        DFS.dfs(listOf(1), neighbors, object : DFS.AbstractNodeHandler<Int, String>() {
            override fun afterChildren(current: Int) { events += "a$current"; if (current == 2) throw fault }
            override fun result(): String { events += "result"; return "result" }
        })
    } catch (error: Throwable) { cases += "dfs-after-failure:${error === fault}:$events" }
    events = mutableListOf()
    try {
        DFS.dfs(listOf(1), neighbors, object : DFS.AbstractNodeHandler<Int, String>() {
            override fun afterChildren(current: Int) { events += "a$current" }
            override fun result(): String { events += "result"; throw fault }
        })
    } catch (error: Throwable) { cases += "dfs-result-failure:${error === fault}:$events" }

    for ([id, list] in listOf(
        "empty" to SmartList<String?>(), "one" to SmartList<String?>("one"), "null" to SmartList<String?>(null),
        "collection-one" to SmartList<String?>(listOf("one")), "collection-three" to SmartList<String?>(listOf("a", null, "b")),
        "vararg-empty" to SmartList<String?>(*emptyArray()), "vararg-three" to SmartList<String?>(*arrayOf("a", null, "b")),
        "set" to SmartList<String?>(linkedSetOf("a", "b"))
    )) cases += "list-ctor-$id:${list.size}:${list.getModificationCount()}:$list"
    val transition = SmartList<String?>()
    transition.add(null)
    transition.add("one")
    transition.add(0, "head")
    transition.add(2, "middle")
    cases += "list-add:${transition.size}:${transition.getModificationCount()}:$transition"
    cases += "list-set:${transition.set(1, "changed")}:${transition.getModificationCount()}:$transition"
    cases += "list-remove:${transition.removeAt(2)}:${transition.removeAt(0)}:${transition.getModificationCount()}:$transition"
    transition.removeAt(0)
    cases += "list-collapse:${transition.size}:${transition.getModificationCount()}:$transition"
    transition.removeAt(0)
    transition.clear()
    cases += "list-clear:${transition.size}:${transition.getModificationCount()}:$transition"
    for (operation in listOf<() -> Unit>({ transition[-1] }, { transition[0] }, { transition.add(-1, "x") }, { transition.add(1, "x") }, { transition.set(0, "x") }, { transition.removeAt(0) }))
        cases += "list-bounds:${failure(operation)}"
    val empty = SmartList<String>()
    val emptyIterator = empty.iterator()
    val otherEmptyIterator = SmartList<String>().iterator()
    empty.add("new")
    cases += "iterator-empty:${emptyIterator === otherEmptyIterator}:${emptyIterator.hasNext()}:${failure { emptyIterator.next() }}:${failure { emptyIterator.remove() }}"
    val single = SmartList("old")
    val singleton = single.iterator()
    single[0] = "changed"
    cases += "iterator-single:${singleton.next()}:${singleton.hasNext()}:${failure { singleton.next() }}"
    singleton.remove()
    cases += "iterator-single-remove:${single.size}:${single.getModificationCount()}:${failure { singleton.remove() }}"
    val beforeNext = SmartList("old")
    val beforeNextIterator = beforeNext.iterator()
    beforeNextIterator.remove()
    cases += "iterator-single-before-next:${beforeNext.size}:${failure { beforeNextIterator.next() }}:${failure { beforeNextIterator.next() }}"
    val changed = SmartList("old")
    val changedIterator = changed.iterator()
    changed.add("new")
    cases += "iterator-single-invalid:${failure { changedIterator.next() }}:${changedIterator.hasNext()}:${failure { changedIterator.next() }}"
    val many = SmartList(listOf("a", "b", "c"))
    val manyIterator = many.iterator()
    cases += "iterator-many-before:${failure { manyIterator.remove() }}:${manyIterator.next()}"
    manyIterator.remove()
    val manyNext = manyIterator.next()
    val manyBeforeRemoval = "${many.size}:${many.getModificationCount()}:${many.toString()}"
    val manyRemovalFailure = failure { manyIterator.remove(); manyIterator.remove() }
    cases += "iterator-many-remove:$manyNext:$manyBeforeRemoval:$manyRemovalFailure:${many.toString()}:${many.size}:${many.getModificationCount()}"
    val invalid = SmartList(listOf("a", "b", "c"))
    val invalidIterator = invalid.iterator()
    invalidIterator.next()
    invalid.removeAt(2)
    cases += "iterator-many-invalid:${invalidIterator.hasNext()}:${failure { invalidIterator.next() }}:${failure { invalidIterator.remove() }}"
    val positioned = SmartList(listOf("a", "b", "c"))
    val listIterator = positioned.listIterator(1)
    cases += "list-iterator-position:${listIterator.nextIndex()}:${listIterator.previousIndex()}:${listIterator.hasPrevious()}:${failure { listIterator.set("x") }}"
    cases += "list-iterator-mutate:${listIterator.previous()}"
    listIterator.set("changed")
    listIterator.add("inserted")
    val positionedNext = listIterator.nextIndex()
    val positionedPrevious = listIterator.previous()
    val positionedBeforeRemoval = positioned.toString()
    val positionedRemovalFailure = failure { listIterator.remove(); listIterator.remove() }
    cases += "list-iterator-add:$positionedNext:$positionedPrevious:$positionedBeforeRemoval:$positionedRemovalFailure:${positioned.toString()}:${positioned.size}:${positioned.getModificationCount()}"
    val trim = SmartList<Int>()
    repeat(3) { trim.add(it) }
    val trimIterator = trim.iterator()
    val beforeTrim = trim.getModificationCount()
    trim.trimToSize()
    cases += "list-trim:${trim.getModificationCount() - beforeTrim}:$trim:${failure { trimIterator.next() }}"
    val afterTrim = trim.getModificationCount()
    trim.trimToSize()
    cases += "list-trim-noop:${trim.getModificationCount() - afterTrim}"
    val sort = SmartList(listOf("b1", "a1", "b2", "a2"))
    val sortIterator = sort.iterator()
    val beforeSort = sort.getModificationCount()
    probeSort(sort, Comparator { a, b -> a[0].compareTo(b[0]) })
    cases += "list-sort-stable:$sort:${sort.getModificationCount() - beforeSort}:${sortIterator.next()}"
    val naturalSort = SmartList(listOf(3, 1, 2))
    probeSort(naturalSort, null)
    cases += "list-sort-natural:$naturalSort"
    var compareCalls = 0
    probeSort(SmartList("a"), Comparator { _, _ -> compareCalls++; throw fault })
    cases += "list-sort-single:$compareCalls"
    val failedSort = SmartList(listOf(3, 1, 2))
    try { probeSort(failedSort, Comparator { _, _ -> throw fault }) } catch (error: Throwable) { cases += "list-sort-failure:${error === fault}:${failedSort.getModificationCount()}:$failedSort" }
    for ([id, list] in listOf("empty" to SmartList<String?>(), "single" to SmartList<String?>(null), "multiple" to SmartList<String?>(listOf("a", null, "b")))) {
        for (capacity in listOf(0, 1, 5)) {
            val target = Array<String?>(capacity) { "sentinel$it" }
            val array = list.toArray(target)
            cases += "list-array-$id-$capacity:${array === target}:${array.contentToString()}:${target.contentToString()}"
        }
        cases += "list-array-object-$id:${list.toArray().contentToString()}"
    }
    val bulk = SmartList(listOf<String?>("a", null, "b", "a"))
    cases += "list-equality:${bulk.indexOf("a")}:${bulk.lastIndexOf("a")}:${bulk.indexOf(null)}:${bulk == listOf("a", null, "b", "a")}:${bulk.hashCode()}"
    cases += "list-bulk:${bulk.remove(null)}:${bulk.addAll(1, listOf("x", "y"))}:${bulk.addAll(emptyList())}:${bulk.removeAll(listOf("a"))}:${bulk.retainAll(listOf("x", "b"))}:$bulk:${bulk.getModificationCount()}"
    val sub = SmartList(listOf("a", "b", "c", "d"))
    val view = sub.subList(1, 3)
    view.removeAt(0)
    view.add("x")
    cases += "list-subview:$sub:$view:${sub.getModificationCount()}"
    sub.add("outside")
    cases += "list-subview-invalid:${failure { view[0] }}"
    val random = SmartList<Int?>()
    var seed = 0x1234567
    var digest = 1
    repeat(2048) {
        seed = seed * 1103515245 + 12345
        val bits = seed ushr 1
        val value: Int? = if (bits % 17 == 0) null else bits % 51
        when (bits % 8) {
            0 -> random.add(value)
            1 -> random.add(if (random.isEmpty()) 0 else bits % (random.size + 1), value)
            2 -> if (random.isNotEmpty()) random.removeAt(bits % random.size)
            3 -> if (random.isNotEmpty()) random[bits % random.size] = value
            4 -> random.trimToSize()
            5 -> probeSort(random, Comparator { a, b -> compareValues(a, b) })
            6 -> random.remove(value)
            7 -> if (bits % 19 == 0) random.clear() else random.add(value)
        }
        val state = "${random.getModificationCount()}:$random"
        for (c in state) digest = digest * 31 + c.code
    }
    cases += "list-random-2048:$digest:${random.size}:${random.getModificationCount()}:$random"
    check(cases.size == 68) { "Unexpected observer denominator ${cases.size}" }
    return "{\"cases\":[" + cases.joinToString(",", transform = ::quoted) + "]}"
}
