// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

enum class JsBinaryOperator(private val symbolValue: String, private val precedenceValue: Int, private val mask: Int) : JsOperator {
    MUL("*", 13, JsOperator.LEFT or JsOperator.INFIX),
    DIV("/", 13, JsOperator.LEFT or JsOperator.INFIX),
    MOD("%", 13, JsOperator.LEFT or JsOperator.INFIX),
    ADD("+", 12, JsOperator.LEFT or JsOperator.INFIX),
    SUB("-", 12, JsOperator.LEFT or JsOperator.INFIX),
    SHL("<<", 11, JsOperator.LEFT or JsOperator.INFIX),
    SHR(">>", 11, JsOperator.LEFT or JsOperator.INFIX),
    SHRU(">>>", 11, JsOperator.LEFT or JsOperator.INFIX),
    LT("<", 10, JsOperator.LEFT or JsOperator.INFIX),
    LTE("<=", 10, JsOperator.LEFT or JsOperator.INFIX),
    GT(">", 10, JsOperator.LEFT or JsOperator.INFIX),
    GTE(">=", 10, JsOperator.LEFT or JsOperator.INFIX),
    INSTANCEOF("instanceof", 10, JsOperator.LEFT or JsOperator.INFIX),
    INOP("in", 10, JsOperator.LEFT or JsOperator.INFIX),
    EQ("==", 9, JsOperator.LEFT or JsOperator.INFIX),
    NEQ("!=", 9, JsOperator.LEFT or JsOperator.INFIX),
    REF_EQ("===", 9, JsOperator.LEFT or JsOperator.INFIX),
    REF_NEQ("!==", 9, JsOperator.LEFT or JsOperator.INFIX),
    BIT_AND("&", 8, JsOperator.LEFT or JsOperator.INFIX),
    BIT_XOR("^", 7, JsOperator.LEFT or JsOperator.INFIX),
    BIT_OR("|", 6, JsOperator.LEFT or JsOperator.INFIX),
    AND("&&", 5, JsOperator.LEFT or JsOperator.INFIX),
    OR("||", 4, JsOperator.LEFT or JsOperator.INFIX),
    ASG_ADD("+=", JsAssignmentOperation.PRECEDENCE, JsOperator.INFIX),
    ASG_SUB("-=", JsAssignmentOperation.PRECEDENCE, JsOperator.INFIX),
    ASG_MUL("*=", JsAssignmentOperation.PRECEDENCE, JsOperator.INFIX),
    ASG_DIV("/=", JsAssignmentOperation.PRECEDENCE, JsOperator.INFIX),
    ASG_MOD("%=", JsAssignmentOperation.PRECEDENCE, JsOperator.INFIX),
    ASG_SHL("<<=", JsAssignmentOperation.PRECEDENCE, JsOperator.INFIX),
    ASG_SHR(">>=", JsAssignmentOperation.PRECEDENCE, JsOperator.INFIX),
    ASG_SHRU(">>>=", JsAssignmentOperation.PRECEDENCE, JsOperator.INFIX),
    ASG_BIT_AND("&=", JsAssignmentOperation.PRECEDENCE, JsOperator.INFIX),
    ASG_BIT_OR("|=", JsAssignmentOperation.PRECEDENCE, JsOperator.INFIX),
    ASG_BIT_XOR("^=", JsAssignmentOperation.PRECEDENCE, JsOperator.INFIX),
    COMMA(",", 1, JsOperator.LEFT or JsOperator.INFIX);

    override fun getPrecedence(): Int = precedenceValue
    override fun getSymbol(): String = symbolValue
    fun isAssignment(): Boolean = getPrecedence() == JsAssignmentOperation.PRECEDENCE
    override fun isKeyword(): Boolean = this == INSTANCEOF || this == INOP
    override fun isLeftAssociative(): Boolean = (mask and JsOperator.LEFT) != 0
    override fun toString(): String = symbolValue
}
