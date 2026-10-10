@file:OptIn(kotlin.js.ExperimentalJsExport::class)
package org.jetbrains.kotlin.portable.messages.probe
import kotlin.js.JsExport
@JsExport fun compilerMessageProbe(): String = observeMessages()
