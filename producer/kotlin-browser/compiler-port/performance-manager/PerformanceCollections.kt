/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.util.portable

/** The report input keeps its caller-owned sorted-set view. Implementations must preserve
 * their comparator order, comparator-based uniqueness, and live Set iteration semantics.
 * This is the complete capability consumed by TimestampReportsData, not a Java facade.
 */
interface PerformanceReportSortedSet<T> : Set<T>

/** Binary min-heap used only by StatsCalculator. Its array iteration and tie decisions
 * match java.util.PriorityQueue's comparator sift-up/sift-down behavior.
 */
internal class PerformanceReportHeap<T>(initialCapacity: Int, private val comparator: Comparator<T>) : Iterable<T> {
    init { require(initialCapacity >= 1) }
    private val items = ArrayList<T>(initialCapacity)
    val size: Int get() = items.size
    override fun iterator(): Iterator<T> = items.iterator()
    fun peek(): T = items.first()
    fun add(value: T) {
        var index = items.size
        items.add(value)
        while (index > 0) {
            val parent = (index - 1) ushr 1
            val parentValue = items[parent]
            if (comparator.compare(value, parentValue) >= 0) break
            items[index] = parentValue
            index = parent
        }
        items[index] = value
    }
    fun poll(): T? {
        if (items.isEmpty()) return null
        val result = items[0]
        val last = items.removeAt(items.lastIndex)
        if (items.isNotEmpty()) {
            var index = 0
            val half = items.size ushr 1
            while (index < half) {
                var child = (index shl 1) + 1
                val right = child + 1
                if (right < items.size && comparator.compare(items[child], items[right]) > 0) child = right
                if (comparator.compare(last, items[child]) <= 0) break
                items[index] = items[child]
                index = child
            }
            items[index] = last
        }
        return result
    }
}
