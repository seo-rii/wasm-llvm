// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil

class JsNameRef : JsAssignableExpression, HasName {
    private var identifier: String? = null
    private var referencedName: JsName? = null
    private var qualifierValue: JsExpression? = null
    private constructor() : super()
    constructor(name: JsName) : super() { referencedName = name }
    constructor(ident: String) : super() { identifier = ident }
    constructor(ident: String, qualifier: JsExpression?) : super() { identifier = ident; qualifierValue = qualifier }
    constructor(ident: String, qualifier: String) : this(ident, JsNameRef(qualifier))
    constructor(name: JsName, qualifier: JsExpression?) : super() { referencedName = name; qualifierValue = qualifier }
    fun getIdent(): String? = if (referencedName == null) identifier else referencedName!!.getIdent()
    override fun getName(): JsName? = referencedName
    override fun setName(name: JsName?) { referencedName = name }
    fun getQualifier(): JsExpression? = qualifierValue
    override fun isLeaf(): Boolean = qualifierValue == null
    fun resolve(name: JsName?) { referencedName = name; identifier = null }
    fun setQualifier(qualifier: JsExpression?) { qualifierValue = qualifier }
    override fun accept(v: JsVisitor) { v.visitNameRef(this) }
    override fun acceptChildren(visitor: JsVisitor) { if (qualifierValue != null) visitor.accept(qualifierValue) }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) { if (qualifierValue != null) qualifierValue = v.accept(qualifierValue) }
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsNameRef {
        val qualifierCopy = AstUtil.deepCopy(qualifierValue)
        if (referencedName != null) return JsNameRef(referencedName!!, qualifierCopy).withMetadataFrom(this)
        val copy = JsNameRef()
        copy.identifier = identifier
        copy.qualifierValue = qualifierCopy
        return copy.withMetadataFrom(this)
    }
}
