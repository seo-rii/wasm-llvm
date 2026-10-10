// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil
import org.jetbrains.kotlin.utils.SmartList

open class JsBlock(private val _statements: List<JsStatement>) : SourceInfoAwareJsNode(), JsStatement {
    private var _closingBraceSource: JsLocationWithSource? = null
    constructor() : this(SmartList<JsStatement>())
    constructor(statement: JsStatement) : this(SmartList(statement))
    constructor(vararg statements: JsStatement) : this(SmartList(*statements))
    open fun getStatements(): List<JsStatement> = _statements
    open fun getClosingBraceSource(): JsLocationWithSource? = _closingBraceSource
    open fun setClosingBraceSource(closingBraceLocation: JsLocationWithSource?) { _closingBraceSource = closingBraceLocation }
    open fun isEmpty(): Boolean = _statements.isEmpty()
    open fun isTransparent(): Boolean = false
    override fun accept(v: JsVisitor) { v.visitBlock(this) }
    override fun acceptChildren(visitor: JsVisitor) { visitor.acceptWithInsertRemove(_statements) }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) v.acceptStatementList(_statements)
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsBlock {
        val block = JsBlock(AstUtil.deepCopy(_statements)).withMetadataFrom(this)
        block.setClosingBraceSource(getClosingBraceSource())
        return block
    }
}
