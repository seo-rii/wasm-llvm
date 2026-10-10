/*
 * Copyright 2010-2026 JetBrains s.r.o. and Kotlin Programming Language contributors.
 * Use of this source code is governed by the Apache 2.0 license that can be found in the license/LICENSE.txt file.
 */

package org.jetbrains.kotlin.js.backend.ast

class JsBooleanLiteral(private val literalValue: Boolean) : JsLiteral.JsValueLiteral() {
    fun getValue(): Boolean = literalValue
    override fun accept(v: JsVisitor) { v.visitBoolean(this) }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        v.visit(this, ctx)
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsBooleanLiteral = JsBooleanLiteral(literalValue).withMetadataFrom(this)
    companion object {
        fun isTrue(expression: JsExpression): Boolean = expression is JsBooleanLiteral && expression.getValue()
        fun isFalse(expression: JsExpression): Boolean = expression is JsBooleanLiteral && !expression.getValue()
    }
}
