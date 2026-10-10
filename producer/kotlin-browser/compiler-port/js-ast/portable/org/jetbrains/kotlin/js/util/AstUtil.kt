// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.util

import org.jetbrains.kotlin.js.backend.ast.JsNode
import org.jetbrains.kotlin.utils.SmartList

object AstUtil {
    @Suppress("UNCHECKED_CAST")
    fun <T : JsNode?> deepCopy(node: T): T = node?.deepCopy() as T
    fun <T : JsNode> deepCopy(nodes: List<T>?): MutableList<T> {
        if (nodes == null) return SmartList()
        val copy = ArrayList<T>(nodes.size)
        for (node in nodes) copy.add(deepCopy(node))
        return copy
    }
}
