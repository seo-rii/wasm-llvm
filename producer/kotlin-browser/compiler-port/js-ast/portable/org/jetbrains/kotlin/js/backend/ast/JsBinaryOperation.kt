// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil

class JsBinaryOperation(private val op: JsBinaryOperator, arg1: JsExpression?, arg2: JsExpression?) : JsExpression() {
    private var firstArgument: JsExpression? = arg1
    private var secondArgument: JsExpression? = arg2
    fun getArg1(): JsExpression? = firstArgument
    fun getArg2(): JsExpression? = secondArgument
    fun setArg1(arg1: JsExpression?) { firstArgument = arg1 }
    fun setArg2(arg2: JsExpression?) { secondArgument = arg2 }
    fun getOperator(): JsBinaryOperator = op
    override fun accept(v: JsVisitor) { v.visitBinaryExpression(this) }
    override fun acceptChildren(visitor: JsVisitor) {
        if (op.isAssignment()) visitor.acceptLvalue(firstArgument!!) else visitor.accept(firstArgument)
        visitor.accept(secondArgument)
    }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) {
            firstArgument = if (op.isAssignment()) v.acceptLvalue(firstArgument) else v.accept(firstArgument)
            secondArgument = v.accept(secondArgument)
        }
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsExpression = JsBinaryOperation(op, AstUtil.deepCopy(firstArgument), AstUtil.deepCopy(secondArgument)).withMetadataFrom(this)
}
