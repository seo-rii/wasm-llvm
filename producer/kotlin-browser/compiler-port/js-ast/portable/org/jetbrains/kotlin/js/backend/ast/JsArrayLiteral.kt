// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil
import org.jetbrains.kotlin.utils.SmartList

class JsArrayLiteral : JsLiteral {
    private val expressionList: List<JsExpression>
    constructor() : super() { expressionList = SmartList() }
    constructor(expressions: List<JsExpression>) : super() { expressionList = expressions }
    fun getExpressions(): List<JsExpression> = expressionList
    override fun accept(v: JsVisitor) { v.visitArray(this) }
    override fun acceptChildren(visitor: JsVisitor) { visitor.acceptWithInsertRemove(expressionList) }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) v.acceptList(expressionList)
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsArrayLiteral = JsArrayLiteral(AstUtil.deepCopy(expressionList)).withMetadataFrom(this)
}
