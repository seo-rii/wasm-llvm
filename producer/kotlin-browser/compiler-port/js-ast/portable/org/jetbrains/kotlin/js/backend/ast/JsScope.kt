// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.Maps

abstract class JsScope {
    private val descriptionText: String
    private var names: Map<String, JsName> = emptyMap()
    private val parentScope: JsScope?

    constructor(parent: JsScope?, description: String) { parentScope = parent; descriptionText = description }
    protected constructor(description: String) { parentScope = null; descriptionText = description }

    open fun declareName(identifier: String): JsName = findOwnName(identifier) ?: doCreateName(identifier)
    fun findName(ident: String): JsName? = findOwnName(ident) ?: parentScope?.findName(ident)
    open fun hasOwnName(name: String): Boolean = names.containsKey(name)
    private fun hasName(name: String): Boolean = hasOwnName(name) || parentScope?.hasName(name) == true
    fun getParent(): JsScope? = parentScope
    final override fun toString(): String = if (parentScope != null) "$descriptionText->$parentScope" else descriptionText
    open fun copyOwnNames(other: JsScope?) {
        other!!
        if (other.names.isNotEmpty()) names = HashMap(names).apply { putAll(other.names) }
    }
    open fun getDescription(): String = descriptionText
    protected open fun doCreateName(ident: String): JsName {
        val name = JsName(ident, false)
        names = Maps.put(names, ident, name)
        return name
    }
    protected open fun findOwnName(ident: String): JsName? = names[ident]
    companion object {
        fun declareTemporaryName(suggestedName: String): JsName {
            if (suggestedName.isEmpty()) throw AssertionError()
            return JsName(suggestedName, true)
        }
    }
}
