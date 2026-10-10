@file:OptIn(kotlin.js.ExperimentalJsExport::class)

package org.jetbrains.kotlin.kmp.probe

import kotlin.js.JsExport

@JsExport
fun parserSnapshot(source: String): String = snapshot(source)
