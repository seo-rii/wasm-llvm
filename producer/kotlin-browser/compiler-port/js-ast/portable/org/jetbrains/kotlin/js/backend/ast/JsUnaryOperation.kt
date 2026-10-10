// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

abstract class JsUnaryOperation(private val op: JsUnaryOperator, arg: JsExpression?) : JsExpression() {
    private var argument: JsExpression? = arg
    fun getArg(): JsExpression? = argument
    fun getOperator(): JsUnaryOperator = op
    fun setArg(arg: JsExpression?) { argument = arg }
    override fun acceptChildren(visitor: JsVisitor) {
        // delete is treated as an lvalue, as in the original compiler.
        if (op.isModifying()) visitor.acceptLvalue(argument!!) else visitor.accept(argument)
    }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        // delete is treated as an lvalue, as in the original compiler.
        argument = if (op.isModifying()) v.acceptLvalue(argument) else v.accept(argument)
    }
}
