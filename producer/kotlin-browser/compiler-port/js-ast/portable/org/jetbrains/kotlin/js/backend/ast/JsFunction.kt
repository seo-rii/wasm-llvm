// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.AstUtil
import org.jetbrains.kotlin.utils.SmartList

class JsFunction private constructor(parentScope: JsScope, description: String, private var functionName: JsName?) : JsLiteral(), HasName {
    enum class Modifier { STATIC, GET, SET, GENERATOR }
    private var functionBody: JsBlock? = null
    private var params: MutableList<JsParameter>? = null
    private val functionScope = JsFunctionScope(parentScope, functionName?.getIdent() ?: description)
    private var computedFunctionName: JsExpression? = null
    private var functionModifiers: MutableSet<Modifier>? = null
    private var es6Arrow = false

    constructor(parentScope: JsScope, description: String) : this(parentScope, description, null)
    constructor(parentScope: JsScope, body: JsBlock, description: String) : this(parentScope, description, null) { functionBody = body }
    // The original Java body reference is deliberately unset by its scope-only constructor.
    fun getBody(): JsBlock? = functionBody
    override fun getName(): JsName? = functionName
    fun getComputedName(): JsExpression? = computedFunctionName
    fun getParameters(): MutableList<JsParameter> = params ?: SmartList<JsParameter>().also { params = it }
    fun getScope(): JsFunctionScope = functionScope
    fun isStatic(): Boolean = functionModifiers?.contains(Modifier.STATIC) == true
    fun isGetter(): Boolean = functionModifiers?.contains(Modifier.GET) == true
    fun isSetter(): Boolean = functionModifiers?.contains(Modifier.SET) == true
    fun isGenerator(): Boolean = functionModifiers?.contains(Modifier.GENERATOR) == true
    fun getModifiers(): MutableSet<Modifier> = functionModifiers ?: ModifierSet().also { functionModifiers = it }
    fun isEs6Arrow(): Boolean = es6Arrow
    fun setEs6Arrow(value: Boolean) {
        if (value && functionName != null) throw IllegalArgumentException("Only anonymous function can be made an ES6 arrow")
        es6Arrow = value
    }
    fun setBody(body: JsBlock) { functionBody = body }
    override fun setName(name: JsName?) { functionName = name }
    fun setComputedName(computedName: JsExpression?) { computedFunctionName = computedName }
    override fun accept(v: JsVisitor) { v.visitFunction(this) }
    override fun acceptChildren(visitor: JsVisitor) {
        visitor.acceptWithInsertRemove(getParameters())
        visitor.accept(functionBody)
    }
    override fun traverse(v: JsVisitorWithContext, ctx: JsContext<*>) {
        if (v.visit(this, ctx)) {
            v.acceptList(getParameters())
            functionBody = v.acceptStatement(functionBody)
        }
        v.endVisit(this, ctx)
    }
    override fun deepCopy(): JsFunction {
        val functionCopy = JsFunction(functionScope.getParent()!!, functionScope.getDescription(), functionName)
        functionCopy.getScope().copyOwnNames(functionScope)
        functionCopy.setBody(functionBody!!.deepCopy())
        functionCopy.params = AstUtil.deepCopy(params)
        functionCopy.functionModifiers = functionModifiers?.let { original ->
            // EnumSet iteration is declaration order, independent of insertion order.
            ModifierSet().apply { addAll(original) }
        }
        functionCopy.es6Arrow = es6Arrow
        // Original deepCopy does not copy computedName.
        return functionCopy.withMetadataFrom(this)
    }

    private class ModifierSet : AbstractMutableSet<Modifier>() {
        private val present = BooleanArray(Modifier.entries.size)
        override val size: Int get() = present.count { it }
        override fun contains(element: Modifier): Boolean = present[element.ordinal]
        override fun add(element: Modifier): Boolean {
            val previous = present[element.ordinal]
            present[element.ordinal] = true
            return !previous
        }
        override fun iterator(): MutableIterator<Modifier> = object : MutableIterator<Modifier> {
            private val snapshot = present.copyOf()
            private var nextIndex = 0
            private var returnedIndex = -1
            override fun hasNext(): Boolean {
                while (nextIndex < snapshot.size && !snapshot[nextIndex]) nextIndex++
                return nextIndex < snapshot.size
            }
            override fun next(): Modifier {
                if (!hasNext()) throw NoSuchElementException()
                returnedIndex = nextIndex++
                return Modifier.entries[returnedIndex]
            }
            override fun remove() {
                if (returnedIndex < 0) throw IllegalStateException()
                present[returnedIndex] = false
                returnedIndex = -1
            }
        }
    }
}
