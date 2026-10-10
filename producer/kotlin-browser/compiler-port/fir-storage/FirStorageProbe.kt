package org.jetbrains.kotlin.portable.firstorageprobe

import org.jetbrains.kotlin.ir.IrLock
import org.jetbrains.kotlin.ir.declarations.lazy.lazyVar
import org.jetbrains.kotlin.utils.threadLocal

private class CacheKey(val id: Int) {
    override fun hashCode(): Int = 7
    override fun equals(other: Any?): Boolean = other is CacheKey && id == other.id
}

private class LazyOwner(lock: IrLock, initializer: () -> String?) {
    var value: String? by lazyVar(lock, initializer)
}

private class SlotOwner(initializer: () -> String?) {
    var value: String? by threadLocal(initializer)
}

/** Observer values model cache work only; they are not FIR declarations or IR symbols. */
private class WorkItem(var bound: Boolean)

private fun quote(text: String): String = buildString {
    append('"')
    for (character in text) when (character) {
        '"' -> append("\\\"")
        '\\' -> append("\\\\")
        '\n' -> append("\\n")
        '\r' -> append("\\r")
        '\t' -> append("\\t")
        else -> if (character.code < 32) append("\\u" + character.code.toString(16).padStart(4, '0')) else append(character)
    }
    append('"')
}

/** Same observations execute with JDK maps/original bodies and with the common port. */
fun firStorageProbe(): String {
    val cases = mutableListOf<String>()
    val rawTraversal = mutableListOf<String>()
    fun expect(name: String, condition: Boolean) {
        check(condition) { name }
        cases += "$name:ok"
    }
    fun failure(name: String, action: () -> Unit) {
        var actual: Throwable? = null
        try { action() } catch (error: Throwable) { actual = error }
        expect(name, actual is NullPointerException)
    }

    val map = Cache<CacheKey?, String?>()
    val key = CacheKey(1)
    expect("map.empty", map.isEmpty() && map.size == 0)
    expect("map.insert", map.put(key, "first") == null && map.size == 1)
    expect("map.equal-collision", map[CacheKey(1)] == "first" && map[CacheKey(2)] == null)
    expect("map.replace", map.put(CacheKey(1), "second") == "first" && map.size == 1)
    expect("map.put-if-absent-existing", map.putIfAbsent(CacheKey(1), "discarded") == "second")
    expect("map.put-if-absent-new", map.putIfAbsent(CacheKey(2), "third") == null && map.size == 2)
    failure("map.null-get") { map[null] }
    failure("map.null-key") { map[null] = "invalid" }
    failure("map.null-value") { map[CacheKey(3)] = null }
    failure("map.null-if-absent-existing") { map.putIfAbsent(key, null) }
    failure("map.null-contains-key") { map.containsKey(null) }
    failure("map.null-contains-value") { map.containsValue(null) }
    expect("map.null-operations-unmodified", map.size == 2 && map[key] == "second")
    map.putAll(mapOf(CacheKey(3) to "fourth", CacheKey(4) to "fifth"))
    expect("map.put-all-get-value", map.getValue(CacheKey(3)) == "fourth" && map.size == 4)

    val cache = Cache<String, String?>()
    var calls = 0
    expect("compute.first", cache.computeIfAbsent("a") { calls++; "computed" } == "computed")
    expect("compute.cached", cache.computeIfAbsent("a") { error("must not compute") } == "computed" && calls == 1)
    expect("compute.null", cache.computeIfAbsent("null") { calls++; null } == null && !cache.containsKey("null"))
    expect("compute.null-retry", cache.computeIfAbsent("null") { calls++; "retry" } == "retry" && calls == 3)
    val fault = IllegalArgumentException("observer-fault")
    var caught: Throwable? = null
    try { cache.computeIfAbsent("failed") { throw fault } } catch (error: Throwable) { caught = error }
    expect("compute.failure-identity", caught === fault && !cache.containsKey("failed"))
    expect("compute.failure-release", cache.computeIfAbsent("failed") { "recovered" } == "recovered")
    expect("compute.read-only-reentry", cache.computeIfAbsent("read") { cache.computeIfAbsent("a") { error("existing") } } == "computed")
    val recursiveCompute = Cache<String, String>()
    caught = null
    try { recursiveCompute.computeIfAbsent("key") { recursiveCompute["key"] = "invalid"; "candidate" } } catch (error: Throwable) { caught = error }
    expect("compute.recursive-update-rejected", caught is IllegalStateException && !recursiveCompute.containsKey("key"))
    expect("compute.recursive-update-release", recursiveCompute.computeIfAbsent("key") { "retry" } == "retry")
    val nested = Cache<String, Cache<String, String>>()
    nested.computeIfAbsent("outer") { Cache() }["inner"] = "stored"
    expect("compute.selected-nested-container", nested["outer"]?.get("inner") == "stored")

    val reentrant = Cache<String, String?>()
    val winner = reentrant.getOrPut("key") { reentrant["key"] = "inserted"; "candidate" }
    expect("get-or-put-reentrant-winner", winner == "inserted" && reentrant["key"] == "inserted")
    expect("get-or-put-existing-no-callback", reentrant.getOrPut("key") { error("cached") } == "inserted")
    caught = null
    try { reentrant.getOrPut("throws") { reentrant["throws"] = "survives"; throw fault } } catch (error: Throwable) { caught = error }
    expect("get-or-put-throw-keeps-inserted-value", caught === fault && reentrant["throws"] == "survives")
    failure("get-or-put-null-rejected") { reentrant.getOrPut("null") { null } }
    expect("get-or-put-null-not-installed", !reentrant.containsKey("null"))

    val viewed = Cache<CacheKey, String>()
    viewed[CacheKey(1)] = "old"
    viewed[CacheKey(2)] = "two"
    val entries = viewed.entries
    val keys = viewed.keys
    val values = viewed.values
    val iterator = entries.iterator()
    viewed[CacheKey(1)] = "new"
    viewed[CacheKey(3)] = "three"
    expect("views.backed", entries.size == 3 && keys.size == 3 && "new" in values && "old" !in values)
    val visited = mutableMapOf<Int, String>()
    while (iterator.hasNext()) {
        val entry = iterator.next()
        check(visited.put(entry.key.id, entry.value) == null)
    }
    rawTraversal += "view:" + visited.entries.joinToString(",") { "${it.key}=${it.value}" }
    expect("views.weak-existing-and-current-value", visited[1] == "new" && visited[2] == "two")
    expect("views.weak-appends-optional", visited.keys.all { it in 1..3 } && (3 !in visited || visited[3] == "three"))
    expect("views.entry-equality", entries.first { it.key.id == 1 } == mapOf(CacheKey(1) to "new").entries.single())
    expect("views.fresh-iteration", keys.map { it.id }.sorted() == listOf(1, 2, 3) && values.toSet() == setOf("new", "two", "three"))
    val lastNodeMap = Cache<CacheKey, String>()
    lastNodeMap[CacheKey(1)] = "one"
    val lastNodeIterator = lastNodeMap.keys.iterator()
    check(lastNodeIterator.next().id == 1)
    lastNodeMap[CacheKey(2)] = "appended-after-end"
    expect("views.append-after-last-prefetch-omitted", !lastNodeIterator.hasNext())
    val sharedValue = WorkItem(false)
    val shared = Cache<CacheKey, WorkItem>()
    shared[CacheKey(1)] = sharedValue
    shared[CacheKey(2)] = WorkItem(false)
    val filteredClone = Cache<CacheKey, WorkItem>()
    filteredClone.putAll(shared.filterKeys { it.id == 1 })
    sharedValue.bound = true
    expect("clone.filtered-shallow-copy", filteredClone.size == 1 && filteredClone[CacheKey(1)] === sharedValue && filteredClone.getValue(CacheKey(1)).bound)

    // The build extracts the pinned fillUnboundSymbols control flow. Only its
    // concrete symbol operations are parameterized; no compiler types are invented.
    val work = Cache<CacheKey, WorkItem>()
    work[CacheKey(1)] = WorkItem(false)
    work[CacheKey(2)] = WorkItem(false)
    work[CacheKey(3)] = WorkItem(true)
    val initial = setOf(1, 2, 3)
    val resolved = mutableListOf<Int>()
    val generated = mutableListOf<Int>()
    visitUnbound(work, { it.bound }, { resolved += it.id }) { declaration ->
        generated += declaration.id
        if (declaration.id == 1) work[CacheKey(4)] = WorkItem(false)
        work.getValue(declaration).bound = true
    }
    rawTraversal += "fill-unbound:" + generated.joinToString(",")
    expect("fill-unbound.initial-unbound-visited", generated.filter { it in initial }.sorted() == listOf(1, 2))
    expect("fill-unbound.bound-skipped", 3 !in resolved && 3 !in generated)
    expect("fill-unbound.resolve-before-generate", resolved == generated && generated.distinct().size == generated.size)
    expect("fill-unbound.generation-time-insertion-visited", work.size == 4 && generated.contains(4) && work.getValue(CacheKey(4)).bound)
    expect("fill-unbound.initial-and-new-symbols-bound", work.getValue(CacheKey(1)).bound && work.getValue(CacheKey(2)).bound && work.getValue(CacheKey(4)).bound)

    val lock = IrLock()
    val otherLock = IrLock()
    expect("lock.initial", !lockHeld(lock) && !lockHeld(otherLock))
    val nestedResult = lock.withObservedLock {
        check(lockHeld(lock) && !lockHeld(otherLock))
        lock.withObservedLock { check(lockHeld(lock)); 17 }
    }
    expect("lock.nested-finally", nestedResult == 17 && !lockHeld(lock))
    caught = null
    try { lock.withObservedLock { throw fault } } catch (error: Throwable) { caught = error }
    expect("lock.exception-finally", caught === fault && !lockHeld(lock))
    fun nonLocal(): Int { lock.withObservedLock { return 23 } }
    expect("lock.nonlocal-finally", nonLocal() == 23 && !lockHeld(lock))
    lock.withObservedLock {
        try { lock.withObservedLock { throw fault } } catch (_: Throwable) { }
        check(lockHeld(lock))
    }
    expect("lock.inner-failure-outer-held", !lockHeld(lock))

    calls = 0
    val lazy = LazyOwner(lock) { calls++; "lazy" }
    expect("lazy.deferred", calls == 0)
    expect("lazy.cached", lazy.value == "lazy" && lazy.value == "lazy" && calls == 1)
    lazy.value = "changed"
    expect("lazy.setter", lazy.value == "changed" && calls == 1)
    val setBefore = LazyOwner(lock) { error("setter suppresses initializer") }
    setBefore.value = "before"
    expect("lazy.setter-before-get", setBefore.value == "before")
    calls = 0
    val nullableLazy = LazyOwner(lock) { calls++; null }
    expect("lazy.null-cached", nullableLazy.value == null && nullableLazy.value == null && calls == 1)
    calls = 0
    val retryLazy = LazyOwner(lock) { calls++; if (calls == 1) throw fault; "retry" }
    caught = null
    try { retryLazy.value } catch (error: Throwable) { caught = error }
    expect("lazy.failure-unlocks", caught === fault && !lockHeld(lock))
    expect("lazy.failure-retry", retryLazy.value == "retry" && calls == 2)
    lateinit var overwritten: LazyOwner
    overwritten = LazyOwner(lock) { overwritten.value = "setter"; "initializer" }
    expect("lazy.initializer-assignment-order", overwritten.value == "initializer" && overwritten.value == "initializer")

    calls = 0
    val first = SlotOwner { calls++; "first" }
    val second = SlotOwner { calls++; "second" }
    expect("delegate.deferred-owned-slots", calls == 0)
    expect("delegate.owner-isolation", first.value == "first" && second.value == "second" && calls == 2)
    first.value = "changed"
    expect("delegate.setter-isolation", first.value == "changed" && second.value == "second")
    calls = 0
    val retrySlot = SlotOwner { calls++; if (calls == 1) throw fault; "retry" }
    caught = null
    try { retrySlot.value } catch (error: Throwable) { caught = error }
    expect("delegate.failure-identity", caught === fault)
    expect("delegate.failure-retry", retrySlot.value == "retry" && calls == 2)
    calls = 0
    val nullSlot = SlotOwner { calls++; null }
    failure("delegate.null-initializer") { nullSlot.value }
    failure("delegate.null-retry") { nullSlot.value }
    expect("delegate.null-not-installed", calls == 2)
    failure("delegate.null-setter") { first.value = null }
    expect("delegate.null-setter-keeps-value", first.value == "changed")
    lateinit var recursiveSlot: SlotOwner
    recursiveSlot = SlotOwner { recursiveSlot.value = "inserted"; "candidate" }
    expect("delegate.reentrant-winner", recursiveSlot.value == "inserted")
    lateinit var failingSlot: SlotOwner
    failingSlot = SlotOwner { failingSlot.value = "survives"; throw fault }
    caught = null
    try { failingSlot.value } catch (error: Throwable) { caught = error }
    expect("delegate.throw-keeps-inserted-slot", caught === fault && failingSlot.value == "survives")
    expect("delegate.fresh-owner-lifetime", SlotOwner { "fresh" }.value == "fresh" && first.value == "changed")

    return "{\"cases\":[" + cases.joinToString(",") { quote(it) } + "],\"rawTraversal\":[" + rawTraversal.joinToString(",") { quote(it) } + "]}"
}
