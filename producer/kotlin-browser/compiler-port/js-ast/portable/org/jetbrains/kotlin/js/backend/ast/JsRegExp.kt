// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

class JsRegExp : JsLiteral.JsValueLiteral() {
    private var flagsValue: String? = null
    private var patternValue: String? = null
    fun getFlags(): String? = flagsValue
    fun getPattern(): String? = patternValue
    fun setFlags(suffix: String?) { flagsValue = suffix }
    fun setPattern(re: String?) { patternValue = re }
    override fun accept(v: JsVisitor) { v.visitRegExp(this) }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) { v.visit(this, ctx); v.endVisit(this, ctx) }
    override fun deepCopy(): JsRegExp {
        val copy = JsRegExp().withMetadataFrom(this)
        copy.setFlags(flagsValue)
        copy.setPattern(patternValue)
        return copy
    }
}
