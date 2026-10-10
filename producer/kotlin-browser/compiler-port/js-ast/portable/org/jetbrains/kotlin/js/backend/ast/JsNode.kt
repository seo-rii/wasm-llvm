// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

interface JsNode {
    fun accept(visitor: JsVisitor)
    fun acceptChildren(visitor: JsVisitor)
    fun getSource(): JsLocationWithSource?
    fun setSource(info: JsLocationWithSource?)
    fun deepCopy(): JsNode
    fun traverse(visitor: JsVisitorWithContext, ctx: JsContext<*>)
    fun getCommentsBeforeNode(): MutableList<JsComment>?
    fun getCommentsAfterNode(): MutableList<JsComment>?
    fun setCommentsBeforeNode(comments: MutableList<JsComment>?)
    fun setCommentsAfterNode(comments: MutableList<JsComment>?)
}
