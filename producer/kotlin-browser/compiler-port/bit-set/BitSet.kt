/*
 * Copyright (c) 1995, 2020, Oracle and/or its affiliates. All rights reserved.
 * DO NOT ALTER OR REMOVE COPYRIGHT NOTICES OR THIS FILE HEADER.
 *
 * This code is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License version 2 only, as
 * published by the Free Software Foundation.  Oracle designates this
 * particular file as subject to the "Classpath" exception as provided
 * by Oracle in the LICENSE file that accompanied this code.
 *
 * This code is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
 * version 2 for more details (a copy is included in the LICENSE file that
 * accompanied this code).
 *
 * You should have received a copy of the GNU General Public License version
 * 2 along with this work; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin St, Fifth Floor, Boston, MA 02110-1301 USA.
 *
 * Please contact Oracle, 500 Oracle Parkway, Redwood Shores, CA 94065 USA
 * or visit www.oracle.com if you need additional information or have any
 * questions.
 */

package org.jetbrains.kotlin.portable.bits

/** Common port of the selected OpenJDK BitSet word algorithms, not its serialization/stream API. */
class BitSet(nbits: Int = 64) {
    private var words: LongArray
    private var wordsInUse = 0

    init {
        if (nbits < 0) throw NegativeBitSetSizeException("nbits < 0: $nbits")
        words = LongArray(((nbits - 1) shr 6) + 1)
    }

    private fun checkInvariants() {
        check(wordsInUse == 0 || words[wordsInUse - 1] != 0L)
        check(wordsInUse >= 0 && wordsInUse <= words.size)
        check(wordsInUse == words.size || words[wordsInUse] == 0L)
    }

    private fun recalculateWordsInUse() {
        var i = wordsInUse - 1
        while (i >= 0 && words[i] == 0L) i--
        wordsInUse = i + 1
    }

    private fun ensureCapacity(wordsRequired: Int) {
        if (words.size < wordsRequired) words = words.copyOf(maxOf(2 * words.size, wordsRequired))
    }

    private fun expandTo(wordIndex: Int) {
        val wordsRequired = wordIndex + 1
        if (wordsInUse < wordsRequired) {
            ensureCapacity(wordsRequired)
            wordsInUse = wordsRequired
        }
    }

    fun set(bitIndex: Int) {
        if (bitIndex < 0) throw IndexOutOfBoundsException("bitIndex < 0: $bitIndex")
        val wordIndex = bitIndex shr 6
        expandTo(wordIndex)
        words[wordIndex] = words[wordIndex] or (1L shl bitIndex)
        checkInvariants()
    }

    fun clear(bitIndex: Int) {
        if (bitIndex < 0) throw IndexOutOfBoundsException("bitIndex < 0: $bitIndex")
        val wordIndex = bitIndex shr 6
        if (wordIndex >= wordsInUse) return
        words[wordIndex] = words[wordIndex] and (1L shl bitIndex).inv()
        recalculateWordsInUse()
        checkInvariants()
    }

    operator fun get(bitIndex: Int): Boolean {
        if (bitIndex < 0) throw IndexOutOfBoundsException("bitIndex < 0: $bitIndex")
        checkInvariants()
        val wordIndex = bitIndex shr 6
        return wordIndex < wordsInUse && (words[wordIndex] and (1L shl bitIndex)) != 0L
    }

    fun nextSetBit(fromIndex: Int): Int {
        if (fromIndex < 0) throw IndexOutOfBoundsException("fromIndex < 0: $fromIndex")
        checkInvariants()
        var u = fromIndex shr 6
        if (u >= wordsInUse) return -1
        var word = words[u] and (-1L shl fromIndex)
        while (true) {
            if (word != 0L) return (u * 64) + word.countTrailingZeroBits()
            u++
            if (u == wordsInUse) return -1
            word = words[u]
        }
    }

    fun or(set: BitSet) {
        if (this === set) return
        val wordsInCommon = minOf(wordsInUse, set.wordsInUse)
        if (wordsInUse < set.wordsInUse) {
            ensureCapacity(set.wordsInUse)
            wordsInUse = set.wordsInUse
        }
        for (i in 0 until wordsInCommon) words[i] = words[i] or set.words[i]
        if (wordsInCommon < set.wordsInUse) {
            set.words.copyInto(words, wordsInCommon, wordsInCommon, wordsInUse)
        }
        checkInvariants()
    }

    fun andNot(set: BitSet) {
        for (i in minOf(wordsInUse, set.wordsInUse) - 1 downTo 0) words[i] = words[i] and set.words[i].inv()
        recalculateWordsInUse()
        checkInvariants()
    }

    fun size(): Int = words.size * 64

    override fun hashCode(): Int {
        var h = 1234L
        for (i in wordsInUse - 1 downTo 0) h = h xor (words[i] * (i + 1))
        return ((h shr 32) xor h).toInt()
    }

    override fun equals(other: Any?): Boolean {
        if (other !is BitSet) return false
        if (this === other) return true
        checkInvariants()
        other.checkInvariants()
        if (wordsInUse != other.wordsInUse) return false
        for (i in 0 until wordsInUse) if (words[i] != other.words[i]) return false
        return true
    }
}

/** The common exception retains the negative-size category and exact message, without a JVM FQCN. */
class NegativeBitSetSizeException(message: String) : RuntimeException(message)
