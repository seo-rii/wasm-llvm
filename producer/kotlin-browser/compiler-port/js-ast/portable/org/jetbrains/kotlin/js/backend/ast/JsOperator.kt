// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

interface JsOperator {
    fun getPrecedence(): Int
    fun getSymbol(): String
    fun isKeyword(): Boolean
    fun isLeftAssociative(): Boolean
    companion object {
        const val INFIX: Int = 0x02
        const val LEFT: Int = 0x01
        const val POSTFIX: Int = 0x04
        const val PREFIX: Int = 0x08
    }
}
