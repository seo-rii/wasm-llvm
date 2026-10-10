// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

abstract class JsExpression : SourceInfoAwareJsNode() {
    open fun isLeaf(): Boolean = false
    open fun makeStmt(): JsStatement = JsExpressionStatement(this)
    abstract class JsExpressionHasArguments(protected val argumentList: MutableList<JsExpression>) : JsExpression(), HasArguments {
        override fun getArguments(): MutableList<JsExpression> = argumentList
    }
    abstract override fun deepCopy(): JsExpression
}
