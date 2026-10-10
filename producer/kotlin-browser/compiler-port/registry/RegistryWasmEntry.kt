package org.jetbrains.kotlin.portable.registryprobe

import kotlin.js.JsExport

@JsExport fun registryProbeJson(): String {
    val first = registryProbe()
    check(registryProbe() == first) { "Registry lifetime changed the second observation" }
    return first
}
