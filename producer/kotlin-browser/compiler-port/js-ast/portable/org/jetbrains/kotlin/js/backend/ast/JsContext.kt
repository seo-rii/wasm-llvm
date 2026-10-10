// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

abstract class JsContext<T : JsNode> {
    open fun <R : T> addPrevious(node: R) { throw UnsupportedOperationException() }
    fun <R : T> addPrevious(nodes: List<R>) { for (node in nodes) addPrevious(node) }
    abstract fun removeMe()
    abstract fun <R : T> replaceMe(node: R?)
    abstract fun getCurrentNode(): T?
}
