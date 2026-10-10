// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

class JsProgram : SourceInfoAwareJsNode() {
    private val programBlock = JsCompositeBlock()
    private val programRootScope = JsRootScope(this)
    private val programScope = JsObjectScope(programRootScope, "Global")
    fun getGlobalBlock(): JsCompositeBlock = programBlock
    fun getRootScope(): JsRootScope = programRootScope
    fun getScope(): JsObjectScope = programScope
    override fun accept(v: JsVisitor) { v.visitProgram(this) }
    override fun acceptChildren(visitor: JsVisitor) { visitor.accept(programBlock) }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) v.accept(programBlock)
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsProgram { throw UnsupportedOperationException() }
}
