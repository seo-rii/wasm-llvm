// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil

open class JsDoWhile : JsWhile {
    constructor() : super()
    constructor(condition: JsExpression?, body: JsStatement?) : super(condition, body)
    override fun accept(v: JsVisitor) { v.visitDoWhile(this) }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) {
            _body = v.acceptStatement(_body)
            _condition = v.accept(_condition)
        }
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsDoWhile {
        val conditionCopy = AstUtil.deepCopy(_condition)
        val bodyCopy = AstUtil.deepCopy(_body)
        return JsDoWhile(conditionCopy, bodyCopy).withMetadataFrom(this)
    }
}
