/* Observer of the selected compiler's real BitSet utility bodies and host operations. */
package org.jetbrains.kotlin.portable.bits.probe

import org.jetbrains.kotlin.utils.copy
import org.jetbrains.kotlin.utils.forEachBit
import org.jetbrains.kotlin.utils.mapEachBit

private fun quote(value: String): String = buildString {
    append('"')
    for (c in value) when (c) {
        '\\' -> append("\\\\")
        '"' -> append("\\\"")
        '\n' -> append("\\n")
        '\r' -> append("\\r")
        '\t' -> append("\\t")
        else -> if (c.code < 32) append("\\u" + c.code.toString(16).padStart(4, '0')) else append(c)
    }
    append('"')
}

private fun describe(bits: SelectedBitSet): String = buildString {
    append("{\"size\":${bits.size()},\"hash\":${bits.hashCode()},\"positions\":[")
    var separator = ""
    bits.forEachBit { append(separator); append(it); separator = "," }
    append("],\"mapped\":[")
    append(bits.mapEachBit { it * 7 }.joinToString(","))
    append("]}")
}

fun observe(): String {
    val cases = mutableListOf<String>()
    fun record(id: String, value: String) { cases.add("[${quote(id)},$value]") }
    val edges = listOf(0, 1, 31, 32, 62, 63, 64, 65, 127, 128, 129, 255, 256, 511, 512, 1023)
    for (capacity in listOf(0, 1, 63, 64, 65, 127, 128, 257, 2048)) {
        val bits = SelectedBitSet(capacity)
        record("empty/$capacity", describe(bits))
        for (index in edges) {
            bits.set(index)
            record("set/$capacity/$index", describe(bits))
            record("get/$capacity/$index", bits.get(index).toString())
            for (start in listOf(index, maxOf(0, index - 1), index + 1).distinct()) {
                record("next/$capacity/$index/$start", bits.nextSetBit(start).toString())
            }
        }
        val copy = bits.copy()
        record("copy/$capacity", "[${describe(copy)},${copy == bits},${copy === bits}]")
        copy.clear(63)
        record("copy-mutation/$capacity", "[${describe(copy)},${describe(bits)},${copy == bits}]")
        for (index in edges.reversed()) {
            bits.clear(index)
            record("clear/$capacity/$index", describe(bits))
        }
        bits.clear(4096)
        record("clear-absent/$capacity", describe(bits))
        record("equals-capacity/$capacity", (bits == SelectedBitSet(0)).toString())
        record("equals-null/$capacity", bits.equals(null).toString())
        record("equals-other/$capacity", bits.equals("different").toString())
    }
    for (leftCapacity in listOf(0, 64, 257)) for (rightCapacity in listOf(0, 64, 2048)) {
        val left = SelectedBitSet(leftCapacity)
        val right = SelectedBitSet(rightCapacity)
        for (bit in edges.filter { it % 2 == 0 }) left.set(bit)
        for (bit in edges.filter { it % 3 == 0 }) right.set(bit)
        val beforeRight = describe(right)
        left.or(right)
        record("or/$leftCapacity/$rightCapacity", "[${describe(left)},${describe(right)},${quote(beforeRight)}]")
        left.or(left)
        record("or-self/$leftCapacity/$rightCapacity", describe(left))
        left.andNot(right)
        record("and-not/$leftCapacity/$rightCapacity", "[${describe(left)},${describe(right)}]")
        left.andNot(left)
        record("and-not-self/$leftCapacity/$rightCapacity", describe(left))
    }
    val live = SelectedBitSet()
    val predecessor = SelectedBitSet()
    val kill = SelectedBitSet()
    var random = 0x137ace
    for (step in 0 until 512) {
        random = random * 1664525 + 1013904223
        val bit = (random ushr 12) and 2047
        when (step % 8) {
            0, 1, 2 -> live.set(bit)
            3 -> live.clear(bit)
            4 -> predecessor.set(bit)
            5 -> kill.set(bit)
            6 -> live.or(predecessor)
            else -> live.andNot(kill)
        }
        record("data-flow/$step", describe(live))
    }
    for (operation in listOf("get", "set", "clear", "nextSetBit")) {
        val bits = SelectedBitSet()
        bits.set(64)
        val before = describe(bits)
        val failure = try {
            when (operation) {
                "get" -> bits.get(-1)
                "set" -> bits.set(-1)
                "clear" -> bits.clear(-1)
                else -> bits.nextSetBit(-1)
            }
            "missing-failure"
        } catch (e: IndexOutOfBoundsException) { "index-error:${e.message}" }
        record("negative/$operation", "[${quote(failure)},${quote(before)},${describe(bits)}]")
    }
    record("negative/constructor", quote(observeNegativeSize()))
    return "{\"cases\":[${cases.joinToString(",")}],\"count\":${cases.size}}"
}
