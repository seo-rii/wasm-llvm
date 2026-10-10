// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil

class JsBreak : JsContinue {
    constructor() : super(null)
    constructor(label: JsNameRef?) : super(label)
    override fun accept(v: JsVisitor) { v.visitBreak(this) }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) { if (_label != null) _label = v.accept(_label) }
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsBreak = JsBreak(AstUtil.deepCopy(_label)).withMetadataFrom(this)
}
