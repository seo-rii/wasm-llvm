package org.jetbrains.kotlin.portable.smartset.probe

import org.jetbrains.kotlin.utils.SmartSet

// Value objects exercise the real collection dependency; these are not compiler type/descriptor substitutes.
private class CollisionValue(val id: Int) {
    override fun equals(other: Any?): Boolean = other is CollisionValue && id == other.id
    override fun hashCode(): Int = 7
    override fun toString(): String = "collision-$id"
}

private fun failureKind(failure: Throwable): String = when (failure) {
    is NoSuchElementException -> "NoSuchElementException"
    is UnsupportedOperationException -> "UnsupportedOperationException"
    is ConcurrentModificationException -> "ConcurrentModificationException"
    is IllegalStateException -> "IllegalStateException"
    is IllegalArgumentException -> "IllegalArgumentException"
    else -> throw failure
}

private fun result(body: () -> Any?): String = try { body().toString() } catch (failure: Throwable) { "throws:" + failureKind(failure) }
private fun <T> snapshot(set: SmartSet<T>): String = "size=${set.size};empty=${set.isEmpty()};values=" + set.joinToString(",") + ";hash=${set.hashCode()}"
private fun quote(text: String): String = buildString {
    append('"')
    for (character in text) when (character) {
        '"' -> append("\\\"")
        '\\' -> append("\\\\")
        '\n' -> append("\\n")
        '\r' -> append("\\r")
        '\t' -> append("\\t")
        else -> append(character)
    }
    append('"')
}

fun smartSetProbeJson(): String {
    val cases = mutableListOf<Pair<String, String>>()
    val outsideContract = mutableListOf<Pair<String, String>>()
    fun observe(id: String, body: () -> String) { check(cases.none { it.first == id }); cases.add(id to body()) }
    fun outside(id: String, body: () -> String) { check(outsideContract.none { it.first == id }); outsideContract.add(id to body()) }
    val values = listOf<Any?>(null, "한글😀", 0, CollisionValue(1), CollisionValue(2), "tail", Int.MIN_VALUE, Int.MAX_VALUE)

    for (count in 0..values.size) {
        val set = SmartSet.create(values.take(count))
        observe("transition-$count") {
            check(set.size == count && set.toList() == values.take(count))
            snapshot(set)
        }
        observe("duplicates-$count") {
            val before = set.toList()
            for (value in before) check(!set.add(value))
            check(set.toList() == before && !set.addAll(before))
            snapshot(set)
        }
        observe("contains-$count") {
            for (value in values) check(set.contains(value) == values.take(count).contains(value))
            check(!set.contains("absent") && set.containsAll(values.take(count)))
            "present-prefix;absent-rejected"
        }
        observe("equality-$count") {
            val reversed = SmartSet.create(values.take(count).reversed())
            val plain = values.take(count).toSet()
            check(set == reversed && reversed == set && set == plain && plain == set)
            check(set.hashCode() == plain.hashCode())
            check(!set.equals(values.take(count)) && !set.equals(null))
            "reverse-and-standard-set;hash=${set.hashCode()}"
        }
        observe("iterator-exhaustion-$count") {
            val iterator = set.iterator(); val elements = mutableListOf<Any?>()
            while (iterator.hasNext()) elements.add(iterator.next())
            check(elements == values.take(count) && !iterator.hasNext())
            val next = result { iterator.next() }
            check(next == "throws:NoSuchElementException")
            "elements=${elements.joinToString(",")};next=$next"
        }
        observe("clear-reuse-$count") {
            set.clear(); check(set.size == 0 && !set.iterator().hasNext() && !set.contains(null))
            check(set.add(null) && !set.add(null) && set.add("after-clear"))
            snapshot(set)
        }
    }

    observe("collision-growth-and-value-equality") {
        val set = SmartSet.create<CollisionValue>()
        for (id in 0 until 40) check(set.add(CollisionValue(id)))
        for (id in 0 until 40) check(!set.add(CollisionValue(id)) && set.contains(CollisionValue(id)))
        check(set.map { it.id } == (0 until 40).toList())
        snapshot(set)
    }
    observe("null-growth") {
        val set = SmartSet.create<Any?>()
        check(set.add(null))
        for (id in 0 until 20) check(set.add(id))
        check(!set.add(null) && set.toList().first() == null)
        snapshot(set)
    }
    observe("self-membership-and-rendering") {
        val set = SmartSet.create<Any?>(); check(set.add(set))
        check(set.contains(set) && !set.add(set))
        // The inherited collection renderer guards its own self reference; hashing a self-containing set is not attempted.
        set.toString()
    }
    observe("copy-preserves-first-equal-instance") {
        val first = CollisionValue(1); val same = CollisionValue(1)
        val set = SmartSet.create(listOf(first, same, null, CollisionValue(2), CollisionValue(3), CollisionValue(4)))
        check(set.size == 5 && set.first() === first)
        snapshot(set)
    }
    observe("numeric-boundaries-and-boxed-equality") {
        val numbers = listOf<Any>(Double.NaN, 0.0, -0.0, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, Long.MIN_VALUE, Long.MAX_VALUE, Float.NaN)
        val set = SmartSet.create(numbers)
        check(set.size == numbers.size && set.add(0) && set.add(0L))
        check(!set.add(Double.NaN) && !set.add(Float.NaN) && !set.add(-0.0))
        snapshot(set)
    }
    for (count in 0..6) {
        observe("iterator-add-$count") {
            val set = SmartSet.create((0 until count).toList()); val iterator = set.iterator()
            check(set.add(count))
            val seen = mutableListOf<Int>(); var failure = "none"
            try { while (iterator.hasNext()) seen.add(iterator.next()) } catch (error: Throwable) { failure = failureKind(error) }
            if (count < 5) check(seen == (0 until count).toList() && failure == "none")
            else check(failure == "ConcurrentModificationException")
            "seen=${seen.joinToString(",")};failure=$failure;" + snapshot(set)
        }
        observe("iterator-clear-$count") {
            val set = SmartSet.create((0 until count).toList()); val iterator = set.iterator()
            set.clear()
            val seen = mutableListOf<Int>(); while (iterator.hasNext()) seen.add(iterator.next())
            check(seen == (0 until count).toList() && set.size == 0)
            // clear drops SmartSet's reference, so already acquired backing/snapshot iterators retain the old data.
            "seen=${seen.joinToString(",")};" + snapshot(set)
        }
        observe("iterator-duplicate-$count") {
            val set = SmartSet.create((0 until count).toList()); val iterator = set.iterator()
            if (count != 0) check(!set.add(count - 1))
            val seen = mutableListOf<Int>(); while (iterator.hasNext()) seen.add(iterator.next())
            check(seen == (0 until count).toList())
            seen.joinToString(",")
        }
        outside("iterator-remove-before-next-$count") {
            val set = SmartSet.create((0 until count).toList()); val iterator = set.iterator()
            result { iterator.remove() } + ";" + snapshot(set)
        }
        outside("iterator-remove-after-next-$count") {
            val set = SmartSet.create((0 until count).toList()); val iterator = set.iterator()
            if (count != 0) iterator.next()
            val remove = result { iterator.remove() }; val repeat = result { iterator.remove() }
            remove + ";repeat=" + repeat + ";" + snapshot(set)
        }
        outside("remove-present-$count") {
            val set = SmartSet.create((0 until count).toList())
            result { set.remove(0) } + ";" + snapshot(set)
        }
        outside("remove-absent-$count") {
            val set = SmartSet.create((0 until count).toList())
            result { set.remove(-1) } + ";" + snapshot(set)
        }
        outside("remove-all-$count") {
            val set = SmartSet.create((0 until count).toList())
            result { set.removeAll(listOf(0, 1)) } + ";" + snapshot(set)
        }
        outside("retain-all-$count") {
            val set = SmartSet.create((0 until count).toList())
            result { set.retainAll(listOf(0)) } + ";" + snapshot(set)
        }
    }
    observe("deterministic-2048-add-contains-clear") {
        val set = SmartSet.create<Int?>(); val model = mutableListOf<Int?>(); var state = 0x1234567; var digest = 0
        repeat(2048) {
            state = state * 1664525 + 1013904223
            val value = if ((state ushr 8) % 9 == 0) null else (state ushr 4) % 32
            when (state and 15) {
                0 -> { set.clear(); model.clear() }
                1, 2, 3 -> check(set.contains(value) == model.contains(value))
                else -> { val expected = !model.contains(value); check(set.add(value) == expected); if (expected) model.add(value) }
            }
            check(set.size == model.size && set.toList() == model)
            digest = 31 * digest + set.hashCode()
        }
        "seed=01234567;operations=2048;digest=$digest;" + snapshot(set)
    }
    fun encode(entries: List<Pair<String, String>>): String = entries.joinToString(",", "[", "]") {
        "{\"id\":" + quote(it.first) + ",\"value\":" + quote(it.second) + "}"
    }
    return "{\"cases\":" + encode(cases) + ",\"outsideContract\":" + encode(outsideContract) + "}"
}
