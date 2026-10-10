// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.backend.ast.metadata.HasMetadataImpl

open class JsName(private val identifier: String, private val temporaryName: Boolean) : HasMetadataImpl() {
    open fun isTemporary(): Boolean = temporaryName
    open fun getIdent(): String = identifier
    open fun makeRef(): JsNameRef = JsNameRef(this)
    override fun toString(): String = identifier
}
