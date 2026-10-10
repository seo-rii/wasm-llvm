// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil

class JsArrayAccess : JsAssignableExpression {
    private var arrayExpressionValue: JsExpression? = null
    private var indexExpressionValue: JsExpression? = null
    constructor() : super()
    constructor(arrayExpression: JsExpression?, indexExpression: JsExpression?) : super() {
        arrayExpressionValue = arrayExpression
        indexExpressionValue = indexExpression
    }
    fun getArrayExpression(): JsExpression? = arrayExpressionValue
    fun getIndexExpression(): JsExpression? = indexExpressionValue
    fun setArrayExpression(arrayExpression: JsExpression?) { arrayExpressionValue = arrayExpression }
    fun setIndexExpression(indexExpression: JsExpression?) { indexExpressionValue = indexExpression }
    override fun accept(v: JsVisitor) { v.visitArrayAccess(this) }
    override fun acceptChildren(visitor: JsVisitor) {
        visitor.accept(arrayExpressionValue)
        visitor.accept(indexExpressionValue)
    }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) {
            arrayExpressionValue = v.accept(arrayExpressionValue)
            indexExpressionValue = v.accept(indexExpressionValue)
        }
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsArrayAccess {
        val arrayCopy = AstUtil.deepCopy(arrayExpressionValue)
        val indexCopy = AstUtil.deepCopy(indexExpressionValue)
        return JsArrayAccess(arrayCopy, indexCopy).withMetadataFrom(this)
    }
}
