package org.jetbrains.kotlin.portable.text.probe

import kotlin.js.JsExport

@JsExport
fun textProbe(): String = compilerTextProbe()
