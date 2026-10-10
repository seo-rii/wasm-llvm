/*
 * Copyright 2010-2026 JetBrains s.r.o. and Kotlin Programming Language contributors.
 * Use of this source code is governed by the Apache 2.0 license that can be found in the license/LICENSE.txt file.
 */

package org.jetbrains.kotlin.js.backend.ast

open class JsDocComment(tags: Map<String, Any?>) : JsExpression() {
    // Java's Map<String, Object> accepts nullable values and retains the caller's map.
    private val _tags: Map<String, Any?> = tags
    open fun getTags(): Map<String, Any?> = _tags
    override fun accept(v: JsVisitor) { v.visitDocComment(this) }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {}
    override fun deepCopy(): JsDocComment = JsDocComment(_tags).withMetadataFrom(this)
}
