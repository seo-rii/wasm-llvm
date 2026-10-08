package org.jetbrains.kotlin.portable.identityprobe

import kotlin.js.JsExport

@JsExport
fun identityProbeSnapshot(): String = identityProbe()
