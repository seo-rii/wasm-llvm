// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil

open class JsContinue(protected var _label: JsNameRef?) : SourceInfoAwareJsNode(), JsStatement {
    constructor() : this(null)
    open fun getLabel(): JsNameRef? = _label
    override fun accept(v: JsVisitor) { v.visitContinue(this) }
    override fun acceptChildren(v: JsVisitor) { if (_label != null) v.accept(_label) }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) { if (_label != null) _label = v.accept(_label) }
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsContinue {
        if (_label == null) return JsContinue()
        return JsContinue(AstUtil.deepCopy(_label)).withMetadataFrom(this)
    }
}
