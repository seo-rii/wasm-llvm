// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil
import org.jetbrains.kotlin.utils.SmartList

class JsInvocation : JsExpression.JsExpressionHasArguments {
    private var qualifierValue: JsExpression
    constructor(qualifier: JsExpression, arguments: List<JsExpression>) : super(SmartList(arguments)) { qualifierValue = qualifier }
    constructor(qualifier: JsExpression, vararg arguments: JsExpression) : this(qualifier, arguments.asList())
    override fun getArguments(): MutableList<JsExpression> = argumentList
    fun getQualifier(): JsExpression = qualifierValue
    fun setQualifier(qualifier: JsExpression) { qualifierValue = qualifier }
    override fun accept(v: JsVisitor) { v.visitInvocation(this) }
    override fun acceptChildren(visitor: JsVisitor) {
        visitor.accept(qualifierValue)
        visitor.acceptList(argumentList)
    }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) {
            qualifierValue = v.accept(qualifierValue)
            v.acceptList(argumentList)
        }
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsInvocation {
        val qualifierCopy = AstUtil.deepCopy(qualifierValue)
        val argumentsCopy = AstUtil.deepCopy(argumentList)
        return JsInvocation(qualifierCopy, argumentsCopy).withMetadataFrom(this)
    }
}
