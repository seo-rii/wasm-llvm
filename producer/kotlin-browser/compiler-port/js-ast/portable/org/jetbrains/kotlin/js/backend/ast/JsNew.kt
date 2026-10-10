// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil
import org.jetbrains.kotlin.utils.SmartList

class JsNew : JsExpression.JsExpressionHasArguments {
    private var constructorValue: JsExpression?
    constructor(constructorExpression: JsExpression?) : this(constructorExpression, SmartList<JsExpression>())
    constructor(constructorExpression: JsExpression?, arguments: List<JsExpression>) : super(SmartList(arguments)) { constructorValue = constructorExpression }
    constructor(constructorExpression: JsExpression?, vararg arguments: JsExpression) : this(constructorExpression, arguments.asList())
    fun getConstructorExpression(): JsExpression? = constructorValue
    fun setConstructorExpression(constructorExpression: JsExpression?) { constructorValue = constructorExpression }
    override fun accept(v: JsVisitor) { v.visitNew(this) }
    override fun acceptChildren(visitor: JsVisitor) {
        visitor.accept(constructorValue)
        visitor.acceptList(argumentList)
    }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) {
            constructorValue = v.accept(constructorValue)
            v.acceptList(argumentList)
        }
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsNew {
        val constructorCopy = AstUtil.deepCopy(constructorValue)
        val argumentsCopy = AstUtil.deepCopy(argumentList)
        return JsNew(constructorCopy, argumentsCopy).withMetadataFrom(this)
    }
}
