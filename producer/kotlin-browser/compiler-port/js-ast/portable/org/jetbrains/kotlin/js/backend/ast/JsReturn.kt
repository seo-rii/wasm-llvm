// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil

class JsReturn : SourceInfoAwareJsNode, JsStatement {
    private var _expression: JsExpression? = null
    constructor() : super()
    constructor(expression: JsExpression?) : super() { _expression = expression }
    fun getExpression(): JsExpression? = _expression
    fun setExpression(expression: JsExpression?) { _expression = expression }
    override fun accept(v: JsVisitor) { v.visitReturn(this) }
    override fun acceptChildren(visitor: JsVisitor) { if (_expression != null) visitor.accept(_expression) }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) { if (_expression != null) _expression = v.accept(_expression) }
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsReturn = JsReturn(AstUtil.deepCopy(_expression)).withMetadataFrom(this)
}
