package org.jetbrains.kotlin.portable.nameprobe

import kotlin.js.JsExport

@JsExport
fun nameProbeJson(): String = nameProbe()
