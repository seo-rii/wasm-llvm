// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.util

interface TextOutput {
    fun getPosition(): Int
    fun getLine(): Int
    fun getColumn(): Int
    fun indentIn()
    fun indentOut()
    fun newline()
    fun print(c: Char)
    fun print(v: Int)
    fun print(v: Double)
    fun print(s: CharArray)
    fun print(s: CharSequence)
    fun maybeIndent()
}

val TextOutput.position: Int get() = getPosition()
val TextOutput.line: Int get() = getLine()
val TextOutput.column: Int get() = getColumn()
