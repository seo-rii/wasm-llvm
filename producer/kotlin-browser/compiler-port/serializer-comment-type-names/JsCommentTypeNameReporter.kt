/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.portable

import org.jetbrains.kotlin.js.backend.ast.JsComment

/**
 * The owning host reports the actual type of an unknown comment for diagnostics.
 * There is deliberately no default mapping or closed set of comment classes.
 * JVM binary names and another host's genuine type description may differ.
 */
fun interface JsCommentTypeNameReporter {
    fun report(comment: JsComment): String
}
