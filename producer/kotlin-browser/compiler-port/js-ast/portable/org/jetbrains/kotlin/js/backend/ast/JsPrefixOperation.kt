// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil

class JsPrefixOperation(op: JsUnaryOperator, arg: JsExpression?) : JsUnaryOperation(op, arg) {
    override fun accept(v: JsVisitor) { v.visitPrefixOperation(this) }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) super.traverse(v, ctx)
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsPrefixOperation = JsPrefixOperation(getOperator(), AstUtil.deepCopy(getArg())).withMetadataFrom(this)
}
