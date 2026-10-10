/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 *
 * Source port of the selected Kotlin MavenComparableVersion.java. Numeric
 * magnitude uses unlimited normalized decimal digits in place of BigInteger.
 */
package org.jetbrains.kotlin.config

import org.jetbrains.kotlin.portable.versions.versionDigit
import org.jetbrains.kotlin.portable.versions.versionLowercase
import org.jetbrains.kotlin.portable.versions.versionStringCompare

open class MavenComparableVersion(version: String) : Comparable<MavenComparableVersion> {
    private lateinit var value: String
    private lateinit var canonicalValue: String
    open val canonical: String get() = canonicalValue
    private lateinit var items: ListItem

    private interface Item {
        fun compareTo(item: Item?): Int
        fun getType(): Int
        fun isNull(): Boolean
    }

    private class IntegerItem private constructor(private val value: String, @Suppress("UNUSED_PARAMETER") normalized: Boolean) : Item {
        constructor(str: String) : this(normalize(str), true)

        override fun getType(): Int = INTEGER_ITEM
        override fun isNull(): Boolean = value == "0"

        override fun compareTo(item: Item?): Int {
            if (item == null) return if (isNull()) 0 else 1
            return when (item.getType()) {
                INTEGER_ITEM -> {
                    val other = (item as IntegerItem).value
                    when {
                        value.length < other.length -> -1
                        value.length > other.length -> 1
                        value < other -> -1
                        value > other -> 1
                        else -> 0
                    }
                }
                STRING_ITEM, LIST_ITEM -> 1
                else -> error("invalid item: $item")
            }
        }

        override fun toString(): String = value

        companion object {
            val ZERO = IntegerItem("0", true)
            private fun normalize(str: String): String {
                check(str.isNotEmpty())
                val value = StringBuilder(str.length)
                for (char in str) {
                    val digit = versionDigit(char)
                    check(digit >= 0) { "Invalid numeric version component" }
                    if (value.isNotEmpty() || digit != 0) value.append(('0'.code + digit).toChar())
                }
                return if (value.isEmpty()) "0" else value.toString()
            }
        }
    }

    private class StringItem(value: String, followedByDigit: Boolean) : Item {
        private val value: String

        init {
            var normalized = value
            if (followedByDigit && normalized.length == 1) {
                normalized = when (normalized[0]) {
                    'a' -> "alpha"
                    'b' -> "beta"
                    'm' -> "milestone"
                    else -> normalized
                }
            }
            this.value = when (normalized) {
                "ga", "final" -> ""
                "cr" -> "rc"
                else -> normalized
            }
        }

        override fun getType(): Int = STRING_ITEM
        override fun isNull(): Boolean = versionStringCompare(comparableQualifier(value), RELEASE_VERSION_INDEX) == 0
        override fun compareTo(item: Item?): Int {
            if (item == null) return versionStringCompare(comparableQualifier(value), RELEASE_VERSION_INDEX)
            return when (item.getType()) {
                INTEGER_ITEM, LIST_ITEM -> -1
                STRING_ITEM -> versionStringCompare(comparableQualifier(value), comparableQualifier((item as StringItem).value))
                else -> error("invalid item: $item")
            }
        }
        override fun toString(): String = value

        companion object {
            private val QUALIFIERS = listOf("alpha", "beta", "milestone", "rc", "snapshot", "", "sp")
            private val RELEASE_VERSION_INDEX = QUALIFIERS.indexOf("").toString()
            private fun comparableQualifier(qualifier: String): String {
                val index = QUALIFIERS.indexOf(qualifier)
                return if (index == -1) "${QUALIFIERS.size}-$qualifier" else index.toString()
            }
        }
    }

    private class ListItem : Item {
        // Kotlin/Wasm ArrayList is final. This private item only uses these
        // exact original list operations; storage composition retains them.
        private val values = ArrayList<Item>()
        val size: Int get() = values.size
        fun add(item: Item) { values.add(item) }
        fun get(index: Int): Item = values[index]
        fun removeAt(index: Int) { values.removeAt(index) }
        operator fun iterator(): Iterator<Item> = values.iterator()
        override fun getType(): Int = LIST_ITEM
        override fun isNull(): Boolean = size == 0

        fun normalize() {
            for (index in size - 1 downTo 0) {
                val lastItem = get(index)
                if (lastItem.isNull()) removeAt(index) else if (lastItem !is ListItem) break
            }
        }

        override fun compareTo(item: Item?): Int {
            if (item == null) return if (size == 0) 0 else get(0).compareTo(null)
            return when (item.getType()) {
                INTEGER_ITEM -> -1
                STRING_ITEM -> 1
                LIST_ITEM -> {
                    val left = iterator()
                    val right = (item as ListItem).iterator()
                    while (left.hasNext() || right.hasNext()) {
                        val l = if (left.hasNext()) left.next() else null
                        val r = if (right.hasNext()) right.next() else null
                        val result = if (l == null) { if (r == null) 0 else -1 * r.compareTo(l) } else l.compareTo(r)
                        if (result != 0) return result
                    }
                    0
                }
                else -> error("invalid item: $item")
            }
        }

        override fun toString(): String {
            val buffer = StringBuilder()
            for (item in this) {
                if (buffer.isNotEmpty()) buffer.append(if (item is ListItem) '-' else '.')
                buffer.append(item)
            }
            return buffer.toString()
        }
    }

    init { parseVersion(version) }

    fun parseVersion(version: String) {
        this.value = version
        items = ListItem()
        val normalized = versionLowercase(version)
        var list = items
        val stack = ArrayList<ListItem>()
        stack.add(list)
        var isDigit = false
        var startIndex = 0

        for (index in normalized.indices) {
            val char = normalized[index]
            if (char == '.' || char == '-') {
                list.add(if (index == startIndex) IntegerItem.ZERO else parseItem(isDigit, normalized.substring(startIndex, index)))
                startIndex = index + 1
                if (char == '-') {
                    val next = ListItem()
                    list.add(next)
                    list = next
                    stack.add(list)
                }
            } else if (versionDigit(char) >= 0) {
                if (!isDigit && index > startIndex) {
                    list.add(StringItem(normalized.substring(startIndex, index), true))
                    startIndex = index
                    val next = ListItem()
                    list.add(next)
                    list = next
                    stack.add(list)
                }
                isDigit = true
            } else {
                if (isDigit && index > startIndex) {
                    list.add(parseItem(true, normalized.substring(startIndex, index)))
                    startIndex = index
                    val next = ListItem()
                    list.add(next)
                    list = next
                    stack.add(list)
                }
                isDigit = false
            }
        }
        if (normalized.length > startIndex) list.add(parseItem(isDigit, normalized.substring(startIndex)))
        while (stack.isNotEmpty()) stack.removeAt(stack.lastIndex).normalize()
        canonicalValue = items.toString()
    }

    override fun compareTo(other: MavenComparableVersion): Int = items.compareTo(other.items)
    override fun toString(): String = value
    override fun equals(other: Any?): Boolean = other is MavenComparableVersion && canonicalValue == other.canonicalValue
    override fun hashCode(): Int = canonicalValue.hashCode()

    companion object {
        private const val INTEGER_ITEM = 0
        private const val STRING_ITEM = 1
        private const val LIST_ITEM = 2
        private fun parseItem(isDigit: Boolean, buffer: String): Item = if (isDigit) IntegerItem(buffer) else StringItem(buffer, false)
    }
}
