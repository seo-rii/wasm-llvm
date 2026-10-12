package org.jetbrains.kotlin.portable.irlines.probe

import org.jetbrains.kotlin.ir.*

private class File(private val fileName: String, var offsets: IntArray, private val first: Int) : AbstractIrFileEntry() {
    var reads = 0
    override val name: String get() = fileName
    override val maxOffset: Int get() = Int.MAX_VALUE
    override val lineStartOffsets: IntArray get() { reads++; return offsets }
    override val firstRelevantLineIndex: Int get() = first
}

fun runProbe(): String = buildString {
    fun record(label: String, value: Any?) { append(label); append('|'); append(value); append('\n') }
    val arrays = mutableListOf<IntArray>(intArrayOf(), intArrayOf(0), intArrayOf(5),
        intArrayOf(Int.MIN_VALUE, -1, 0, 1, Int.MAX_VALUE), intArrayOf(0, 0, 0, 7, 7, 19), intArrayOf(5, 10, 15))
    for (length in 2..40) {
        arrays += IntArray(length) { it * 3 }
        arrays += IntArray(length) { it / 3 }
    }
    val queries = (-3..128 step 3).toList() + listOf(Int.MIN_VALUE, Int.MAX_VALUE)
    for (arrayIndex in arrays.indices) {
        for (first in listOf(0, 7)) {
            val file = File("file-$arrayIndex", arrays[arrayIndex].copyOf(), first)
            record("debug", file.supportsDebugInfo)
            for (offset in queries) {
                file.reads = 0
                record("line:$arrayIndex:$first:$offset", file.getLineNumber(offset))
                record("line-reads", file.reads)
                file.reads = 0
                record("column:$arrayIndex:$first:$offset", file.getColumnNumber(offset))
                record("column-reads", file.reads)
                file.reads = 0
                record("pair:$arrayIndex:$first:$offset", file.getLineAndColumnNumbers(offset))
                record("pair-reads", file.reads)
            }
            for (begin in listOf(-1, 0, 1, 7, 129)) {
                for (end in listOf(-1, 0, 6, 25, Int.MAX_VALUE)) {
                    file.reads = 0
                    record("range:$arrayIndex:$first:$begin:$end", file.getSourceRangeInfo(begin, end))
                    record("range-reads", file.reads)
                }
            }
            val other = File(file.name, file.offsets.copyOf(), first + 1)
            record("equal-own", file == file)
            record("equal-content", file == other)
            record("hash-content", file.hashCode() == other.hashCode())
            record("equal-name", file == File("other", file.offsets.copyOf(), first))
            record("equal-null", file.equals(null))
            val live = file.getLineStartOffsetsForSerialization()
            record("serialized", live.joinToString(","))
            if (file.offsets.isNotEmpty()) {
                file.offsets[file.offsets.lastIndex] = 401
                record("serialized-live", live.last())
                record("changed-search", file.getLineNumber(402))
            }
            file.offsets = intArrayOf(100, 200, 300)
            record("replaced-line", file.getLineNumber(205))
            record("replaced-column", file.getColumnNumber(205))
            record("old-serialization", live.joinToString(","))
        }
    }
    record("undefined-line", UNDEFINED_LINE_NUMBER)
    record("undefined-column", UNDEFINED_COLUMN_NUMBER)
    record("undefined-pair", UNDEFINED_LINE_AND_COLUMN)
}
