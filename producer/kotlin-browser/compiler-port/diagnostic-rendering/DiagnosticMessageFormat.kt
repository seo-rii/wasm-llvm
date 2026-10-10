/*
 * Copyright (c) 1996, 2020, Oracle and/or its affiliates. All rights reserved.
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

/*
 * (C) Copyright Taligent, Inc. 1996, 1997 - All Rights Reserved
 * (C) Copyright IBM Corp. 1996 - 1998 - All Rights Reserved
 *
 *   The original version of this source code and documentation is copyrighted
 * and owned by Taligent, Inc., a wholly-owned subsidiary of IBM. These
 * materials are provided under terms of a License Agreement between Taligent
 * and Sun. This technology is protected by multiple US and International
 * patents. This notice and attribution to Taligent may not be removed.
 *   Taligent is a registered trademark of Taligent, Inc.
 *
 */

/* ChoiceFormat portions: Copyright (c) 1996, 2019, Oracle and/or its affiliates. */
/* Integer.parseInt portions: Copyright (c) 1994, 2021, Oracle and/or its affiliates. */
/* Modified 2026-10-10: Kotlin common port restricted to the audited English diagnostic profile. */

package org.jetbrains.kotlin.portable.diagnostics

/**
 * The compiler's English diagnostic profile, not a replacement for all java.text formats.
 * Pattern/choice state machines follow the pinned OpenJDK MessageFormat/ChoiceFormat.
 * The selected callers pass renderer Strings and five raw Int type-argument counts.
 */
class DiagnosticMessageFormat(message: String) {
    private data class Insertion(val offset: Int, val argument: Int, val format: Subformat?)
    private sealed interface Subformat {
        data object Integer : Subformat
        class Choice(val limits: DoubleArray, val texts: Array<String>) : Subformat
    }

    private val insertions = mutableListOf<Insertion>()
    private val pattern: String

    init {
        val segments = arrayOfNulls<StringBuilder>(4)
        segments[0] = StringBuilder()
        var part = 0
        var inQuote = false
        var braceStack = 0
        var i = 0
        while (i < message.length) {
            val ch = message[i]
            if (part == 0) {
                if (ch == '\'') {
                    if (i + 1 < message.length && message[i + 1] == '\'') {
                        segments[part]!!.append(ch)
                        i++
                    } else {
                        inQuote = !inQuote
                    }
                } else if (ch == '{' && !inQuote) {
                    part = 1
                    if (segments[1] == null) segments[1] = StringBuilder()
                } else {
                    segments[part]!!.append(ch)
                }
            } else if (inQuote) {
                segments[part]!!.append(ch)
                if (ch == '\'') inQuote = false
            } else {
                when (ch) {
                    ',' -> if (part < 3) {
                        part++
                        if (segments[part] == null) segments[part] = StringBuilder()
                    } else segments[part]!!.append(ch)
                    '{' -> {
                        braceStack++
                        segments[part]!!.append(ch)
                    }
                    '}' -> if (braceStack == 0) {
                        part = 0
                        makeFormat(segments)
                        segments[1] = null
                        segments[2] = null
                        segments[3] = null
                    } else {
                        braceStack--
                        segments[part]!!.append(ch)
                    }
                    ' ' -> if (part != 2 || segments[2]!!.isNotEmpty()) segments[part]!!.append(ch)
                    '\'' -> {
                        inQuote = true
                        segments[part]!!.append(ch)
                    }
                    else -> segments[part]!!.append(ch)
                }
            }
            i++
        }
        if (braceStack == 0 && part != 0) throw IllegalArgumentException("Unmatched braces in the pattern.")
        pattern = segments[0].toString()
    }

    private fun makeFormat(parts: Array<StringBuilder?>) {
        val raw = parts.map { it?.toString() ?: "" }
        val index = try {
            parseArgumentIndex(raw[1])
        } catch (cause: NumberFormatException) {
            throw IllegalArgumentException("can't parse argument number: " + raw[1], cause)
        }
        if (index < 0) throw IllegalArgumentException("negative argument number: " + index)
        if (index >= 10000) throw IllegalArgumentException("$index exceeds the ArgumentIndex implementation limit")
        val type = keyword(raw[2])
        val format = when (type) {
            "" -> null
            "number" -> when (keyword(raw[3])) {
                "", "integer" -> Subformat.Integer
                else -> throw UnsupportedOperationException("Unclosed diagnostic number format: " + raw[3])
            }
            "date", "time" -> throw UnsupportedOperationException("Unclosed diagnostic date/time format: " + raw[2])
            "choice" -> try {
                choice(raw[3])
            } catch (cause: Exception) {
                throw IllegalArgumentException("Choice Pattern incorrect: " + raw[3], cause)
            }
            else -> throw IllegalArgumentException("unknown format type: " + raw[2])
        }
        insertions.add(Insertion(raw[0].length, index, format))
    }

    /** java Integer.parseInt's sign/overflow algorithm with common Unicode decimal-digit lookup. */
    private fun parseArgumentIndex(value: String): Int {
        fun invalid(): Nothing = throw NumberFormatException("For input string: \"$value\"")
        if (value.isEmpty()) invalid()
        var negative = false
        var index = 0
        var limit = -Int.MAX_VALUE
        if (value[0] < '0') {
            if (value[0] == '-') { negative = true; limit = Int.MIN_VALUE }
            else if (value[0] != '+') invalid()
            if (value.length == 1) invalid()
            index++
        }
        val multMin = limit / 10
        var result = 0
        while (index < value.length) {
            val digit = value[index++].digitToIntOrNull(10) ?: invalid()
            if (result < multMin) invalid()
            result *= 10
            if (result < limit + digit) invalid()
            result -= digit
        }
        return if (negative) result else -result
    }

    /** java String.trim removes characters <= U+0020; Kotlin's wider whitespace trim would differ. */
    private fun keyword(value: String): String = value.trim { it <= ' ' }.lowercase()

    private fun choice(value: String): Subformat.Choice {
        val segments = arrayOf(StringBuilder(), StringBuilder())
        val limits = mutableListOf<Double>()
        val formats = mutableListOf<String>()
        var part = 0
        var startValue = 0.0
        var oldStartValue = Double.NaN
        var inQuote = false
        var i = 0
        while (i < value.length) {
            val ch = value[i]
            if (ch == '\'') {
                if (i + 1 < value.length && value[i + 1] == ch) {
                    segments[part].append(ch)
                    i++
                } else inQuote = !inQuote
            } else if (inQuote) {
                segments[part].append(ch)
            } else if (ch == '<' || ch == '#' || ch == '\u2264') {
                if (segments[0].isEmpty()) throw IllegalArgumentException("Each interval must contain a number before a format")
                startValue = when (val number = segments[0].toString()) {
                    "\u221e" -> Double.POSITIVE_INFINITY
                    "-\u221e" -> Double.NEGATIVE_INFINITY
                    else -> number.toDouble()
                }
                if (ch == '<' && startValue != Double.POSITIVE_INFINITY && startValue != Double.NEGATIVE_INFINITY)
                    startValue = nextUp(startValue)
                if (startValue <= oldStartValue) throw IllegalArgumentException("Incorrect order of intervals, must be in ascending order")
                segments[0].setLength(0)
                part = 1
            } else if (ch == '|') {
                limits.add(startValue)
                formats.add(segments[1].toString())
                oldStartValue = startValue
                segments[1].setLength(0)
                part = 0
            } else segments[part].append(ch)
            i++
        }
        if (part == 1) { limits.add(startValue); formats.add(segments[1].toString()) }
        return Subformat.Choice(limits.toDoubleArray(), formats.toTypedArray())
    }

    private fun nextUp(number: Double): Double = when {
        number.isNaN() || number == Double.POSITIVE_INFINITY -> number
        number == 0.0 -> Double.fromBits(1)
        number > 0 -> Double.fromBits(number.toBits() + 1)
        else -> Double.fromBits(number.toBits() - 1)
    }

    /** The audited en-US integer profile has ASCII digits, grouping size 3 and a '-' prefix. */
    private fun integer(number: Any): String {
        if (number !is Number) throw IllegalArgumentException("Cannot format given Object as a Number")
        val digits = when (number) {
            is Int -> number.toString()
            else -> throw UnsupportedOperationException("Unclosed diagnostic fractional/other Number value")
        }
        val start = if (digits.startsWith('-')) 1 else 0
        return buildString {
            if (start == 1) append('-')
            for (i in start..<digits.length) {
                if (i > start && (digits.length - i) % 3 == 0) append(',')
                append(digits[i])
            }
        }
    }

    fun format(arguments: Array<out Any?>?): String = buildString {
        var lastOffset = 0
        for (insertion in insertions) {
            append(pattern, lastOffset, insertion.offset)
            lastOffset = insertion.offset
            if (arguments == null || insertion.argument >= arguments.size) {
                append('{').append(insertion.argument).append('}')
                continue
            }
            val value = arguments[insertion.argument]
            val rendered = when {
                value == null -> "null"
                insertion.format is Subformat.Choice -> {
                    if (value !is Number) throw IllegalArgumentException("Cannot format given Object as a Number")
                    if (value !is Int) throw UnsupportedOperationException("Unclosed diagnostic choice Number value")
                    val number = value.toDouble()
                    val subformat = insertion.format
                    var index = 0
                    while (index < subformat.limits.size && number >= subformat.limits[index]) index++
                    index--
                    if (index < 0) index = 0
                    val chosen = subformat.texts[index]
                    if ('{' in chosen) DiagnosticMessageFormat(chosen).format(arguments) else chosen
                }
                insertion.format is Subformat.Integer || value is Number -> integer(value)
                value is String -> value
                else -> throw UnsupportedOperationException("Unclosed diagnostic parameter type")
            }
            append(rendered)
        }
        append(pattern, lastOffset, pattern.length)
    }

    companion object {
        const val DIAGNOSTIC_LOCALE: String = "en-US"
        fun format(pattern: String, vararg arguments: Any?): String = DiagnosticMessageFormat(pattern).format(arguments)
    }
}
