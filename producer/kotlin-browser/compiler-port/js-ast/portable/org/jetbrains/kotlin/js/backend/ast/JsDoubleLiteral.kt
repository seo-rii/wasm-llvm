/*
 * Copyright 2010-2026 JetBrains s.r.o. and Kotlin Programming Language contributors.
 * Use of this source code is governed by the Apache 2.0 license that can be found in the license/LICENSE.txt file.
 */

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.javaDoubleToString

class JsDoubleLiteral(val value: Double) : JsNumberLiteral() {
    override fun accept(v: JsVisitor) { v.visitDouble(this) }
    override fun toString(): String = javaDoubleToString(value)
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        v.visit(this, ctx)
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsDoubleLiteral = JsDoubleLiteral(value).withMetadataFrom(this)
}
