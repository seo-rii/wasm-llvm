// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil

class JsDefault : JsSwitchMember() {
    override fun accept(v: JsVisitor) { v.visitDefault(this) }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) v.acceptStatementList(_statements)
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsDefault {
        val defaultCopy = JsDefault()
        defaultCopy._statements.addAll(AstUtil.deepCopy(_statements))
        return defaultCopy.withMetadataFrom(this)
    }
}
