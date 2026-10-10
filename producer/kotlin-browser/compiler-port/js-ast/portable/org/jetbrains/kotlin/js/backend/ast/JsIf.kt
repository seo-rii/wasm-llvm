// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil

class JsIf(private var _ifExpression: JsExpression, private var _thenStatement: JsStatement, private var _elseStatement: JsStatement?) : SourceInfoAwareJsNode(), JsStatement {
    constructor(ifExpression: JsExpression, thenStatement: JsStatement) : this(ifExpression, thenStatement, null)
    fun getElseStatement(): JsStatement? = _elseStatement
    fun getIfExpression(): JsExpression = _ifExpression
    fun getThenStatement(): JsStatement = _thenStatement
    fun setElseStatement(elseStatement: JsStatement?) { _elseStatement = elseStatement }
    fun setIfExpression(ifExpression: JsExpression) { _ifExpression = ifExpression }
    fun setThenStatement(thenStatement: JsStatement) { _thenStatement = thenStatement }
    override fun accept(v: JsVisitor) { v.visitIf(this) }
    override fun acceptChildren(visitor: JsVisitor) {
        visitor.accept(_ifExpression)
        visitor.accept(_thenStatement)
        if (_elseStatement != null) visitor.accept(_elseStatement)
    }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) {
            _ifExpression = v.accept(_ifExpression)
            _thenStatement = v.acceptStatement(_thenStatement)
            if (_elseStatement != null) _elseStatement = v.acceptStatement(_elseStatement)
        }
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsIf {
        val ifCopy = AstUtil.deepCopy(_ifExpression)
        val thenCopy = AstUtil.deepCopy(_thenStatement)
        val elseCopy = AstUtil.deepCopy(_elseStatement)
        return JsIf(ifCopy, thenCopy, elseCopy).withMetadataFrom(this)
    }
}
