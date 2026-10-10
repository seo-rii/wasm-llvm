// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil

open class JsWhile : SourceInfoAwareJsNode, JsLoop {
    protected var _body: JsStatement? = null
    protected var _condition: JsExpression? = null
    constructor() : super()
    constructor(condition: JsExpression?, body: JsStatement?) : super() {
        _condition = condition
        _body = body
    }
    open fun getBody(): JsStatement? = _body
    open fun getCondition(): JsExpression? = _condition
    open fun setBody(body: JsStatement?) { _body = body }
    open fun setCondition(condition: JsExpression?) { _condition = condition }
    override fun accept(v: JsVisitor) { v.visitWhile(this) }
    override fun acceptChildren(visitor: JsVisitor) {
        visitor.accept(_condition)
        visitor.accept(_body)
    }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) {
            _condition = v.accept(_condition)
            _body = v.acceptStatement(_body)
        }
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsWhile {
        val conditionCopy = AstUtil.deepCopy(_condition)
        val bodyCopy = AstUtil.deepCopy(_body)
        return JsWhile(conditionCopy, bodyCopy).withMetadataFrom(this)
    }
}
