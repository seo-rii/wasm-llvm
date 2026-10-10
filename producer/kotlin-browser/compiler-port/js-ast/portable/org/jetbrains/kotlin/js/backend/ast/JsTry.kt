// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil
import org.jetbrains.kotlin.js.util.asJavaMutableList
import org.jetbrains.kotlin.utils.SmartList

open class JsTry : SourceInfoAwareJsNode, JsStatement {
    private val _catches: List<JsCatch>
    private var _finallyBlock: JsBlock? = null
    private var _tryBlock: JsBlock? = null
    constructor() : super() { _catches = SmartList() }
    constructor(tryBlock: JsBlock?, catches: List<JsCatch>, finallyBlock: JsBlock?) : super() {
        _tryBlock = tryBlock
        _catches = catches
        _finallyBlock = finallyBlock
    }
    constructor(tryBlock: JsBlock?, jsCatch: JsCatch?, finallyBlock: JsBlock?) : this(tryBlock, SmartList<JsCatch>(), finallyBlock) {
        if (jsCatch != null) asJavaMutableList(_catches).add(jsCatch)
    }
    open fun getCatches(): List<JsCatch> = _catches
    open fun getFinallyBlock(): JsBlock? = _finallyBlock
    open fun getTryBlock(): JsBlock? = _tryBlock
    open fun setFinallyBlock(block: JsBlock?) { _finallyBlock = block }
    open fun setTryBlock(block: JsBlock?) { _tryBlock = block }
    override fun accept(v: JsVisitor) { v.visitTry(this) }
    override fun acceptChildren(visitor: JsVisitor) {
        visitor.accept(_tryBlock)
        visitor.acceptWithInsertRemove(_catches)
        if (_finallyBlock != null) visitor.accept(_finallyBlock)
    }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) {
            _tryBlock = v.acceptStatement(_tryBlock)
            v.acceptList(_catches)
            if (_finallyBlock != null) _finallyBlock = v.acceptStatement(_finallyBlock)
        }
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsTry {
        val tryCopy = AstUtil.deepCopy(_tryBlock)
        val catchCopy = AstUtil.deepCopy(_catches)
        val finallyCopy = AstUtil.deepCopy(_finallyBlock)
        return JsTry(tryCopy, catchCopy, finallyCopy).withMetadataFrom(this)
    }
}
