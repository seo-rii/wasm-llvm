// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

abstract class JsLiteral : JsExpression() {
    /** A JavaScript string literal expression. */
    abstract class JsValueLiteral protected constructor() : JsLiteral() {
        final override fun isLeaf(): Boolean = true
        override fun deepCopy(): JsExpression = this
    }
}
