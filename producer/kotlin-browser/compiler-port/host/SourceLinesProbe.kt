/*
 * Copyright 2026 wasm-llvm contributors.
 * SPDX-License-Identifier: Apache-2.0
 */
package org.jetbrains.kotlin.portable.source.lines.probe

import org.jetbrains.kotlin.KtSourceFileLinesMapping
import org.jetbrains.kotlin.KtSourceFileLinesMappingFromLineStartOffsets
import org.jetbrains.kotlin.toSourceLinesMapping

/** Exercises the actual compiler mapping, including its public mutable array carrier. */
fun sourceLinesProbe(): String = buildString {
    fun observe(id: String, mapping: KtSourceFileLinesMapping, offsets: IntArray) {
        append("meta:").append(id).append(':').append(mapping.linesCount).append(':').append(mapping.lastOffset).append('\n')
        for (line in 0..<mapping.linesCount) {
            append("start:").append(id).append(':').append(line).append(':').append(mapping.getLineStartOffset(line)).append('\n')
        }
        for (offset in offsets) {
            val position = mapping.getLineAndColumnByOffset(offset)
            append("offset:").append(id).append(':').append(offset).append(':').append(mapping.getLineByOffset(offset))
                .append(':').append(position.first).append(':').append(position.second).append('\n')
        }
    }
    val texts = listOf("", "x", "\n", "\n\n", "a\nb\n", "a\rb\r", "a\r\nb\n\r", "한글\n😀e\u0301\n", "a\u0000b\n", "\u2028\u2029\r\n")
    for (index in texts.indices) {
        val text = texts[index]
        observe("text$index", text.toSourceLinesMapping(), (listOf(Int.MIN_VALUE, Int.MAX_VALUE) + (-3..text.length + 3)).toIntArray())
    }
    val arrays = listOf(intArrayOf(), intArrayOf(0), intArrayOf(0, 0, 0, 4, 4, 8), intArrayOf(-10, -5, 0, 0, 10),
        intArrayOf(Int.MIN_VALUE, -1, 0, Int.MAX_VALUE), IntArray(10001) { it * 3 })
    val targets = (listOf(Int.MIN_VALUE, Int.MAX_VALUE) + (-15..35) + (0..1000).map { it * 31 - 17 }).toIntArray()
    for (index in arrays.indices) {
        val starts = arrays[index]
        observe("array$index", KtSourceFileLinesMappingFromLineStartOffsets(starts, Int.MAX_VALUE), targets)
    }
    val mutableStarts = intArrayOf(0, 3, 10)
    val mutableMapping = KtSourceFileLinesMappingFromLineStartOffsets(mutableStarts, 15)
    observe("mutation-before", mutableMapping, intArrayOf(2, 3, 4, 5, 6, 10, 14))
    mutableStarts[1] = 5
    observe("mutation-after", mutableMapping, intArrayOf(2, 3, 4, 5, 6, 10, 14))
}
