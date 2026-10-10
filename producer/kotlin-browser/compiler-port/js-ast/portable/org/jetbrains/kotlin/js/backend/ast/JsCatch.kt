// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil

open class JsCatch : SourceInfoAwareJsNode {
    protected val _scope: JsCatchScope?
    private var _body: JsBlock? = null
    private var _param: JsParameter
    constructor(declarable: JsDeclarable) : super() {
        _param = JsParameter(declarable)
        _scope = null
    }
    constructor(parent: JsScope?, declarable: JsDeclarable) : super() {
        if (parent == null) throw AssertionError()
        _scope = JsCatchScope(parent, declarable)
        _param = JsParameter(declarable)
    }
    constructor(parent: JsScope?, declarable: JsDeclarable, catchBody: JsStatement) : this(parent, declarable) {
        _body = if (catchBody is JsBlock) catchBody else JsBlock(catchBody)
    }
    open fun getBody(): JsBlock? = _body
    open fun getParameter(): JsParameter = _param
    open fun getScope(): JsScope? = _scope
    open fun setBody(body: JsBlock?) { _body = body }
    override fun accept(v: JsVisitor) { v.visitCatch(this) }
    override fun acceptChildren(visitor: JsVisitor) {
        visitor.accept(_param)
        visitor.accept(_body)
    }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) {
            _param = v.accept(_param)
            _body = v.acceptStatement(_body)
        }
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsCatch {
        val scopeCopy = _scope?.copy()
        val bodyCopy = AstUtil.deepCopy(_body)
        val paramCopy = AstUtil.deepCopy(_param)
        return JsCatch(scopeCopy, bodyCopy, paramCopy).withMetadataFrom(this)
    }
    private constructor(scope: JsCatchScope?, body: JsBlock?, param: JsParameter) : super() {
        _scope = scope
        _body = body
        _param = param
    }
}
