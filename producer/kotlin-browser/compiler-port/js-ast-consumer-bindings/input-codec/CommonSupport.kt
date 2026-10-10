package org.jetbrains.kotlin.js.inputprobe
import org.jetbrains.kotlin.js.portable.JsAstInput
import org.jetbrains.kotlin.js.portable.JsAstInputUnderflow
typealias ProbeInput = JsAstInput
fun inputFailure(error: Throwable): String = if (error is JsAstInputUnderflow) "underflow" else error::class.simpleName ?: "Throwable"
