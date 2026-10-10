/*
 * Copyright 2010-2026 JetBrains s.r.o. and Kotlin Programming Language contributors.
 * Use of this source code is governed by the Apache 2.0 license that can be found in the license/LICENSE.txt file.
 */

package org.jetbrains.kotlin.js.backend.ast

class JsSuperRef : JsLiteral.JsValueLiteral() {
    override fun accept(v: JsVisitor) { v.visitSuper(this) }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) { v.visit(this, ctx); v.endVisit(this, ctx) }
    override fun deepCopy(): JsSuperRef = JsSuperRef().withMetadataFrom(this)
}
