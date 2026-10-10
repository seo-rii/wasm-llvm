// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil

open class JsLabel : SourceInfoAwareJsNode, JsStatement, HasName {
    private var _label: JsName?
    private var _statement: JsStatement? = null
    constructor(label: JsName?) : super() { _label = label }
    constructor(label: JsName?, statement: JsStatement?) : super() {
        _label = label
        _statement = statement
    }
    override fun getName(): JsName? = _label
    override fun setName(name: JsName?) { _label = name }
    open fun getStatement(): JsStatement? = _statement
    open fun setStatement(statement: JsStatement?) { _statement = statement }
    override fun accept(v: JsVisitor) { v.visitLabel(this) }
    override fun acceptChildren(visitor: JsVisitor) { visitor.accept(_statement) }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) _statement = v.acceptStatement(_statement)
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsLabel = JsLabel(_label, AstUtil.deepCopy(_statement)).withMetadataFrom(this)
}
