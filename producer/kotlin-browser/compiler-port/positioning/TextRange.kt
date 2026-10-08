/* Common arithmetic host contract for the hash-pinned bootstrap TextRange API. */
package com.intellij.openapi.util

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

interface Segment {
    val startOffset: Int
    val endOffset: Int
}

open class TextRange protected constructor(
    final override val startOffset: Int,
    final override val endOffset: Int,
    checkForProperTextRange: Boolean,
) : Segment {
    constructor(startOffset: Int, endOffset: Int) : this(startOffset, endOffset, true)

    init { if (checkForProperTextRange) assertProperRange(this) }

    val length: Int get() = endOffset - startOffset
    val isEmpty: Boolean get() = startOffset == endOffset
    fun isProperRange(): Boolean = isProperRange(startOffset, endOffset)
    override fun equals(other: Any?): Boolean = other is TextRange && equalsToRange(other.startOffset, other.endOffset)
    override fun hashCode(): Int = 31 * startOffset + endOffset
    override fun toString(): String = "($startOffset,$endOffset)"
    fun equalsToRange(startOffset: Int, endOffset: Int): Boolean = this.startOffset == startOffset && this.endOffset == endOffset

    fun contains(range: TextRange): Boolean = contains(range as Segment)
    fun contains(segment: Segment): Boolean = containsRange(segment.startOffset, segment.endOffset)
    fun containsRange(startOffset: Int, endOffset: Int): Boolean = this.startOffset <= startOffset && endOffset <= this.endOffset
    fun containsOffset(offset: Int): Boolean = startOffset <= offset && offset <= endOffset
    fun contains(offset: Int): Boolean = startOffset <= offset && offset < endOffset

    fun substring(str: String): String = str.substring(startOffset, endOffset)
    fun subSequence(str: CharSequence): CharSequence = str.subSequence(startOffset, endOffset)
    fun replace(original: String, replacement: String): String = original.substring(0, startOffset) + replacement + original.substring(endOffset)
    fun cutOut(subRange: TextRange): TextRange {
        assertProperRange(subRange)
        if (subRange.endOffset > length) throw IllegalArgumentException("SubRange: $subRange; this=$this")
        return TextRange(startOffset + subRange.startOffset, minOf(endOffset, startOffset + subRange.endOffset))
    }
    fun shiftRight(delta: Int): TextRange = if (delta == 0) this else TextRange(startOffset + delta, endOffset + delta)
    fun shiftLeft(delta: Int): TextRange = shiftRight(-delta)
    fun grown(lengthDelta: Int): TextRange = from(startOffset, length + lengthDelta)
    fun intersects(range: TextRange): Boolean = intersects(range as Segment)
    fun intersects(segment: Segment): Boolean = intersects(segment.startOffset, segment.endOffset)
    fun intersects(startOffset: Int, endOffset: Int): Boolean = maxOf(this.startOffset, startOffset) <= minOf(this.endOffset, endOffset)
    fun intersectsStrict(range: TextRange): Boolean = intersectsStrict(range.startOffset, range.endOffset)
    fun intersectsStrict(startOffset: Int, endOffset: Int): Boolean = maxOf(this.startOffset, startOffset) < minOf(this.endOffset, endOffset)
    fun intersection(range: TextRange): TextRange? {
        if (equals(range)) return this
        val start = maxOf(startOffset, range.startOffset)
        val end = minOf(endOffset, range.endOffset)
        return if (isProperRange(start, end)) TextRange(start, end) else null
    }
    fun union(range: TextRange): TextRange = if (equals(range)) this else TextRange(minOf(startOffset, range.startOffset), maxOf(endOffset, range.endOffset))

    companion object {
        @JvmField val EMPTY_RANGE = TextRange(0, 0)
        @JvmField val EMPTY_ARRAY: Array<TextRange> = emptyArray()
        @JvmStatic fun from(startOffset: Int, length: Int): TextRange = create(startOffset, startOffset + length)
        @JvmStatic fun create(startOffset: Int, endOffset: Int): TextRange = TextRange(startOffset, endOffset)
        @JvmStatic fun create(segment: Segment): TextRange = create(segment.startOffset, segment.endOffset)
        @JvmStatic fun allOf(str: String): TextRange = TextRange(0, str.length)
        @JvmStatic fun areSegmentsEqual(first: Segment, second: Segment): Boolean = first.startOffset == second.startOffset && first.endOffset == second.endOffset
        @JvmStatic fun containsRange(outer: Segment, inner: Segment): Boolean = outer.startOffset <= inner.startOffset && inner.endOffset <= outer.endOffset
        @JvmStatic fun isProperRange(startOffset: Int, endOffset: Int): Boolean = startOffset >= 0 && startOffset <= endOffset
        @JvmStatic fun assertProperRange(segment: Segment) { assertProperRange(segment, "") }
        @JvmStatic fun assertProperRange(segment: Segment, message: Any) { assertProperRange(segment.startOffset, segment.endOffset, message) }
        @JvmStatic fun assertProperRange(startOffset: Int, endOffset: Int, message: Any) {
            if (!isProperRange(startOffset, endOffset)) throw IllegalArgumentException("Invalid range specified: ($startOffset, $endOffset); $message")
        }
    }
}
