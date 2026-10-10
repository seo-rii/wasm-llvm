// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil
import org.jetbrains.kotlin.utils.SmartList

class JsObjectLiteral : JsLiteral {
    private val properties: List<JsPropertyInitializer>
    private var multilineValue: Boolean
    constructor() : this(SmartList<JsPropertyInitializer>())
    constructor(multiline: Boolean) : this(SmartList<JsPropertyInitializer>(), multiline)
    constructor(properties: List<JsPropertyInitializer>) : this(properties, false)
    constructor(properties: List<JsPropertyInitializer>, multiline: Boolean) : super() { this.properties = properties; multilineValue = multiline }
    fun isMultiline(): Boolean = multilineValue
    fun setMultiline(multiline: Boolean) { multilineValue = multiline }
    fun getPropertyInitializers(): List<JsPropertyInitializer> = properties
    override fun accept(v: JsVisitor) { v.visitObjectLiteral(this) }
    override fun acceptChildren(visitor: JsVisitor) { visitor.acceptWithInsertRemove(properties) }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) v.acceptList(properties)
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsObjectLiteral = JsObjectLiteral(AstUtil.deepCopy(properties), multilineValue).withMetadataFrom(this)
}
