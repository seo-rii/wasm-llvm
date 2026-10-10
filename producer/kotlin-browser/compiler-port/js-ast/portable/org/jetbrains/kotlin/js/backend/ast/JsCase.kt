// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil

class JsCase : JsSwitchMember() {
    private var _caseExpression: JsExpression? = null
    fun getCaseExpression(): JsExpression? = _caseExpression
    fun setCaseExpression(caseExpression: JsExpression?) { _caseExpression = caseExpression }
    override fun accept(v: JsVisitor) { v.visitCase(this) }
    override fun acceptChildren(visitor: JsVisitor) {
        visitor.accept(_caseExpression)
        super.acceptChildren(visitor)
    }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) {
            _caseExpression = v.accept(_caseExpression)
            v.acceptStatementList(_statements)
        }
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsCase {
        val caseCopy = JsCase()
        caseCopy._caseExpression = AstUtil.deepCopy(_caseExpression)
        caseCopy._statements.addAll(AstUtil.deepCopy(_statements))
        return caseCopy.withMetadataFrom(this)
    }
}
