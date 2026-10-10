// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil

open class JsSwitch : SourceInfoAwareJsNode, JsStatement {
    private val _cases: List<JsSwitchMember>
    private var _expression: JsExpression? = null
    constructor() : super() { _cases = mutableListOf() }
    constructor(expression: JsExpression?, cases: List<JsSwitchMember>) : super() {
        _expression = expression
        _cases = cases
    }
    open fun getCases(): List<JsSwitchMember> = _cases
    open fun getExpression(): JsExpression? = _expression
    open fun setExpression(expression: JsExpression?) { _expression = expression }
    override fun accept(v: JsVisitor) { v.visit(this) }
    override fun acceptChildren(visitor: JsVisitor) {
        visitor.accept(_expression)
        visitor.acceptWithInsertRemove(_cases)
    }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) {
            _expression = v.accept(_expression)
            v.acceptList(_cases)
        }
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsSwitch {
        val expressionCopy = AstUtil.deepCopy(_expression)
        val casesCopy = AstUtil.deepCopy(_cases)
        return JsSwitch(expressionCopy, casesCopy).withMetadataFrom(this)
    }
}
