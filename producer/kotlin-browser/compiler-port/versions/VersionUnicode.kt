/*
 * Copyright (c) 2003, 2019, Oracle and/or its affiliates. All rights reserved.
 * Copyright (c) 1999, 2016, Oracle and/or its affiliates. All rights reserved.
 *
 * The word-boundary state-machine and Final_Cased adaptation are derived from
 * OpenJDK ConditionalSpecialCasing and RuleBasedBreakIterator. This file is
 * licensed under GPL version 2 with the Classpath exception; see LICENSES.md.
 * The policy data is captured from the SHA-bound reference JDK during production.
 */
package org.jetbrains.kotlin.portable.versions

private fun exactValue(pairs: IntArray, key: Int, fallback: Int): Int {
    var left = 0
    var right = pairs.size / 2 - 1
    while (left <= right) {
        val middle = (left + right).ushr(1)
        val candidate = pairs[middle * 2]
        when {
            candidate < key -> left = middle + 1
            candidate > key -> right = middle - 1
            else -> return pairs[middle * 2 + 1]
        }
    }
    return fallback
}

private fun rangeValue(pairs: IntArray, key: Int, fallback: Int): Int {
    var left = 0
    var right = pairs.size / 2 - 1
    while (left <= right) {
        val middle = (left + right).ushr(1)
        if (pairs[middle * 2] <= key) left = middle + 1 else right = middle - 1
    }
    return if (right < 0) fallback else pairs[right * 2 + 1]
}

internal fun versionDigit(char: Char): Int = exactValue(VersionUnicodeData.digitPairs, char.code, -1)

/** Java String.compareTo exposes the exact UTF-16 difference, beyond its sign. */
internal fun versionStringCompare(left: String, right: String): Int {
    val length = minOf(left.length, right.length)
    for (index in 0 until length) {
        val difference = left[index].code - right[index].code
        if (difference != 0) return difference
    }
    return left.length - right.length
}

private fun codePointAt(text: String, index: Int): Int {
    val first = text[index].code
    if (first in 0xd800..0xdbff && index + 1 < text.length) {
        val second = text[index + 1].code
        if (second in 0xdc00..0xdfff) return 0x10000 + ((first - 0xd800) shl 10) + second - 0xdc00
    }
    return first
}

private fun codePointBefore(text: String, index: Int): Int {
    val last = text[index - 1].code
    if (last in 0xdc00..0xdfff && index > 1) {
        val first = text[index - 2].code
        if (first in 0xd800..0xdbff) return 0x10000 + ((first - 0xd800) shl 10) + last - 0xdc00
    }
    return last
}

private fun charCount(codePoint: Int): Int = if (codePoint >= 0x10000) 2 else 1

/** Exact selected JDK random-access word boundary path, including UTF-16 offsets. */
private class WordIterator(private val text: String) {
    private val data = VersionUnicodeData
    private val categories = data.stateTable.size / data.endStates.size
    private var position = 0
    private var cachedLastKnownBreak = -1

    private fun current(): Int = if (position == text.length) 0xffff else codePointAt(text, position)
    private fun nextIndex(): Int = (position + charCount(current())).coerceAtMost(text.length)
    private fun next(): Int {
        val next = position + charCount(current())
        if (position == text.length || next >= text.length) return 0xffff
        position = next
        return current()
    }
    private fun previous(): Int {
        if (position == 0) return 0xffff
        val ch = text[--position].code
        if (ch in 0xdc00..0xdfff && position > 0) {
            val first = text[--position].code
            if (first in 0xd800..0xdbff) return 0x10000 + ((first - 0xd800) shl 10) + ch - 0xdc00
            position++
        }
        return ch
    }
    private fun handleNext(): Int {
        if (position == text.length) return -1
        var result = nextIndex()
        var lookaheadResult = 0
        var state = 1
        var ch = current()
        while (ch != 0xffff && state != 0) {
            val category = rangeValue(data.wordCategoryRanges, ch, -1)
            if (category != -1) state = data.stateTable[state * categories + category]
            if (data.lookaheadStates[state] != 0) {
                if (data.endStates[state] != 0) result = lookaheadResult else lookaheadResult = nextIndex()
            } else if (data.endStates[state] != 0) result = nextIndex()
            ch = next()
        }
        if (ch == 0xffff && lookaheadResult == text.length) result = lookaheadResult
        position = result
        return result
    }
    private fun handlePrevious(): Int {
        var state = 1
        var category = 0
        var lastCategory = 0
        var ch = current()
        while (ch != 0xffff && state != 0) {
            lastCategory = category
            category = rangeValue(data.wordCategoryRanges, ch, -1)
            if (category != -1) state = data.backwardsStateTable[state * categories + category]
            ch = previous()
        }
        if (ch != 0xffff) {
            if (lastCategory != -1) { next(); next() } else next()
        }
        return position
    }
    private fun following(offset: Int): Int {
        require(offset in 0..text.length)
        position = offset
        if (offset == 0) {
            cachedLastKnownBreak = handleNext()
            return cachedLastKnownBreak
        }
        var result = cachedLastKnownBreak
        if (result >= offset || result <= -1) result = handlePrevious() else position = result
        while (result != -1 && result <= offset) result = handleNext()
        cachedLastKnownBreak = result
        return result
    }
    fun isBoundary(offset: Int): Boolean {
        require(offset in 0..text.length)
        return offset == 0 || following(offset - 1) == offset
    }
}

private fun finalCased(text: String, index: Int): Boolean {
    val boundaries = WordIterator(text)
    var before = index
    while (before >= 0 && !boundaries.isBoundary(before)) {
        val ch = codePointBefore(text, before)
        if (rangeValue(VersionUnicodeData.casedRanges, ch, 0) != 0) {
            var after = index + charCount(codePointAt(text, index))
            while (after < text.length && !boundaries.isBoundary(after)) {
                val next = codePointAt(text, after)
                if (rangeValue(VersionUnicodeData.casedRanges, next, 0) != 0) return false
                after += charCount(next)
            }
            return true
        }
        before -= charCount(ch)
    }
    return false
}

/** ROOT and ENGLISH have the same selected JDK policy; never uses browser locale. */
internal fun versionLowercase(text: String): String {
    val result = StringBuilder(text.length)
    var index = 0
    while (index < text.length) {
        val ch = codePointAt(text, index)
        when {
            ch == 0x0130 -> result.append("i\u0307")
            ch == 0x03a3 && finalCased(text, index) -> result.append('\u03c2')
            else -> {
                val lower = exactValue(VersionUnicodeData.lowercasePairs, ch, ch)
                if (lower < 0x10000) result.append(lower.toChar()) else {
                    result.append((0xd800 + ((lower - 0x10000) ushr 10)).toChar())
                    result.append((0xdc00 + ((lower - 0x10000) and 0x3ff)).toChar())
                }
            }
        }
        index += charCount(ch)
    }
    return result.toString()
}

/** Same sign, Unicode-char digit, negative accumulation and overflow rules as JVM toIntOrNull. */
internal fun versionIntOrNull(text: String): Int? {
    if (text.isEmpty()) return null
    var index = 0
    var negative = false
    if (text[0] == '-' || text[0] == '+') {
        negative = text[0] == '-'
        index++
        if (index == text.length) return null
    }
    val limit = if (negative) Int.MIN_VALUE else -Int.MAX_VALUE
    val multiplyLimit = limit / 10
    var result = 0
    while (index < text.length) {
        val digit = versionDigit(text[index++])
        if (digit < 0 || result < multiplyLimit) return null
        result *= 10
        if (result < limit + digit) return null
        result -= digit
    }
    return if (negative) result else -result
}
