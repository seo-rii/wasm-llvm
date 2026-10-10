// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.util

open class TextOutputImpl : TextOutput {
    private var indentLevel = 0
    private var indents = arrayOf(CharArray(0))
    private var justNewlined = false
    private val out = StringBuilder()
    private var outputPosition = 0
    private var outputLine = 0
    private var outputColumn = 0
    override fun toString(): String = out.toString()
    override fun getPosition(): Int = outputPosition
    override fun getLine(): Int = outputLine
    override fun getColumn(): Int = outputColumn
    override fun indentIn() {
        ++indentLevel
        if (indentLevel >= indents.size) indents += CharArray(indentLevel * 2) { ' ' }
    }
    override fun indentOut() { --indentLevel }
    override fun newline() {
        out.append('\n'); outputPosition++; outputLine++; outputColumn = 0; justNewlined = true
    }
    override fun print(v: Double) {
        maybeIndent()
        val oldLength = out.length
        out.append(javaDoubleToString(v))
        movePosition(out.length - oldLength)
    }
    override fun print(v: Int) {
        maybeIndent()
        val oldLength = out.length
        out.append(v)
        movePosition(out.length - oldLength)
    }
    override fun print(c: Char) { maybeIndent(); out.append(c); movePosition(1) }
    private fun movePosition(length: Int) { outputPosition += length; outputColumn += length }
    override fun print(s: CharArray) { maybeIndent(); printAndCount(s) }
    override fun print(s: CharSequence) { maybeIndent(); printAndCount(s) }
    override fun maybeIndent() {
        if (justNewlined) { printAndCount(indents[indentLevel]); justNewlined = false }
    }
    private fun printAndCount(text: CharSequence) {
        outputPosition += text.length; outputColumn += text.length; out.append(text)
    }
    private fun printAndCount(chars: CharArray) {
        outputPosition += chars.size; outputColumn += chars.size; out.append(chars.concatToString())
    }
}
