// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

class JsExpressionStatement(private var _expression: JsExpression) : AbstractNode(), JsStatement {
    fun getExpression(): JsExpression = _expression
    override fun accept(v: JsVisitor) { v.visitExpressionStatement(this) }
    override fun acceptChildren(visitor: JsVisitor) { visitor.accept(_expression) }
    override fun getSource(): JsLocationWithSource? = null
    override fun setSource(info: JsLocationWithSource?) {
        throw IllegalStateException("You must not set source info for JsExpressionStatement, set for expression")
    }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) _expression = v.accept(_expression)
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsExpressionStatement = JsExpressionStatement(_expression.deepCopy()).withMetadataFrom(this)
}
