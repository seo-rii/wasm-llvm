@file:OptIn(ExperimentalJsExport::class)
package org.jetbrains.kotlin.js.sourcecontentprobe
@JsExport fun astProbeJson(): String = observation().dropLast(1) + ",\"rawText\":\"" + rawTextObservation() + "\"}"
@JsExport fun rawTextProbe(): String = rawTextObservation()
