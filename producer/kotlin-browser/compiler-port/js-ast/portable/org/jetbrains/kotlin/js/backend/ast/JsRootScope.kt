// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.backend.JsReservedIdentifiers

class JsRootScope(private val program: JsProgram) : JsScope("Root") {
    override fun findOwnName(ident: String): JsName? {
        var name = super.findOwnName(ident)
        if (name == null && ident in JsReservedIdentifiers.reservedGlobalSymbols) name = doCreateName(ident)
        return name
    }
}
