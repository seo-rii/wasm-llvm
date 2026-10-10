// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.utils.SmartList

abstract class JsSwitchMember protected constructor() : SourceInfoAwareJsNode() {
    protected val _statements: MutableList<JsStatement> = SmartList()
    open fun getStatements(): MutableList<JsStatement> = _statements
    override fun acceptChildren(visitor: JsVisitor) { visitor.acceptWithInsertRemove(_statements) }
    abstract override fun deepCopy(): JsSwitchMember
}
