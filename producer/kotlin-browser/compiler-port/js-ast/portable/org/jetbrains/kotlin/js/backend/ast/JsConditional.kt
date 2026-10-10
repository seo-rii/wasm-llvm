// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil

class JsConditional : JsExpression {
    private var testValue: JsExpression? = null
    private var elseValue: JsExpression? = null
    private var thenValue: JsExpression? = null
    constructor() : super()
    constructor(testExpression: JsExpression?, thenExpression: JsExpression?, elseExpression: JsExpression?) : super() {
        testValue = testExpression
        thenValue = thenExpression
        elseValue = elseExpression
    }
    fun getElseExpression(): JsExpression? = elseValue
    fun getTestExpression(): JsExpression? = testValue
    fun getThenExpression(): JsExpression? = thenValue
    fun setElseExpression(elseExpression: JsExpression?) { elseValue = elseExpression }
    fun setTestExpression(testExpression: JsExpression?) { testValue = testExpression }
    fun setThenExpression(thenExpression: JsExpression?) { thenValue = thenExpression }
    override fun accept(v: JsVisitor) { v.visitConditional(this) }
    override fun acceptChildren(visitor: JsVisitor) {
        visitor.accept(testValue)
        visitor.accept(thenValue)
        visitor.accept(elseValue)
    }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) {
            testValue = v.accept(testValue)
            thenValue = v.accept(thenValue)
            elseValue = v.accept(elseValue)
        }
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsConditional {
        val testCopy = AstUtil.deepCopy(testValue)
        val thenCopy = AstUtil.deepCopy(thenValue)
        val elseCopy = AstUtil.deepCopy(elseValue)
        return JsConditional(testCopy, thenCopy, elseCopy).withMetadataFrom(this)
    }
}
