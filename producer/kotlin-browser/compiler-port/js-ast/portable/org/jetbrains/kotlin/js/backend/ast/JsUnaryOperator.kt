// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

enum class JsUnaryOperator(private val symbolValue: String, private val precedenceValue: Int, private val mask: Int) : JsOperator {
    BIT_NOT("~", 14, JsOperator.PREFIX),
    DEC("--", 14, JsOperator.POSTFIX or JsOperator.PREFIX),
    DELETE("delete", 14, JsOperator.PREFIX),
    INC("++", 14, JsOperator.POSTFIX or JsOperator.PREFIX),
    NEG("-", 14, JsOperator.PREFIX),
    POS("+", 14, JsOperator.PREFIX),
    NOT("!", 14, JsOperator.PREFIX),
    TYPEOF("typeof", 14, JsOperator.PREFIX),
    VOID("void", 14, JsOperator.PREFIX);

    override fun getPrecedence(): Int = precedenceValue
    override fun getSymbol(): String = symbolValue
    override fun isKeyword(): Boolean = this == DELETE || this == TYPEOF || this == VOID
    fun isModifying(): Boolean = this == DEC || this == INC || this == DELETE
    override fun isLeftAssociative(): Boolean = (mask and JsOperator.LEFT) != 0
    override fun toString(): String = symbolValue
}
