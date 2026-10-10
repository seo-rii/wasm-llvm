// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil

open class JsFor : SourceInfoAwareJsNode, JsLoop {
    private var _body: JsStatement?
    private var _condition: JsExpression?
    private var _incrementExpression: JsExpression?
    private var _initExpression: JsExpression?
    private var _initVars: JsVars?
    constructor(initVars: JsVars?, condition: JsExpression?, incrementExpression: JsExpression?) : this(initVars, condition, incrementExpression, null)
    constructor(initVars: JsVars?, condition: JsExpression?, incrementExpression: JsExpression?, body: JsStatement?) : super() {
        _initVars = initVars
        _incrementExpression = incrementExpression
        _condition = condition
        _body = body
        _initExpression = null
    }
    constructor(initExpression: JsExpression?, condition: JsExpression?, incrementExpression: JsExpression?) : this(initExpression, condition, incrementExpression, null)
    constructor(initExpression: JsExpression?, condition: JsExpression?, incrementExpression: JsExpression?, body: JsStatement?) : super() {
        _initExpression = initExpression
        _incrementExpression = incrementExpression
        _condition = condition
        _body = body
        _initVars = null
    }
    open fun getBody(): JsStatement? = _body
    open fun getCondition(): JsExpression? = _condition
    open fun getIncrementExpression(): JsExpression? = _incrementExpression
    open fun getInitExpression(): JsExpression? = _initExpression
    open fun getInitVars(): JsVars? = _initVars
    open fun setBody(body: JsStatement?) { _body = body }
    override fun accept(v: JsVisitor) { v.visitFor(this) }
    override fun acceptChildren(visitor: JsVisitor) {
        if (_initExpression != null && _initVars != null) throw AssertionError()
        if (_initExpression != null) visitor.accept(_initExpression)
        else if (_initVars != null) visitor.accept(_initVars)
        if (_condition != null) visitor.accept(_condition)
        if (_incrementExpression != null) visitor.accept(_incrementExpression)
        visitor.accept(_body)
    }
    @Suppress("UNCHECKED_CAST")
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) {
            if (_initExpression != null && _initVars != null) throw AssertionError()
            if (_initExpression != null) _initExpression = v.accept(_initExpression)
            else if (_initVars != null) {
                val newInitVars: JsStatement? = v.acceptStatement<JsStatement?>(_initVars)
                if (newInitVars is JsVars) _initVars = newInitVars
                else {
                    _initVars = null
                    if (newInitVars is JsExpressionStatement) _initExpression = newInitVars.getExpression()
                    else if (newInitVars != null) (ctx as JsContext<JsNode>).addPrevious(newInitVars)
                }
            }
            if (_condition != null) _condition = v.accept(_condition)
            if (_incrementExpression != null) _incrementExpression = v.accept(_incrementExpression)
            _body = v.acceptStatement(_body)
        }
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsFor {
        val bodyCopy = AstUtil.deepCopy(_body)
        val conditionCopy = AstUtil.deepCopy(_condition)
        val incrementalExprCopy = AstUtil.deepCopy(_incrementExpression)
        val initVars = _initVars
        val initExpression = _initExpression
        val result = if (initVars != null) JsFor(initVars.deepCopy(), conditionCopy, incrementalExprCopy, bodyCopy)
            else JsFor(initExpression?.deepCopy(), conditionCopy, incrementalExprCopy, bodyCopy)
        return result.withMetadataFrom(this)
    }
}
