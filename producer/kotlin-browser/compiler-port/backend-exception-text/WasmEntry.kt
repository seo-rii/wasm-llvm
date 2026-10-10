@file:OptIn(kotlin.js.ExperimentalJsExport::class)
package org.jetbrains.kotlin.portable.backendtext.probe

@kotlin.js.JsExport
fun backendTextObservation(): String = observeBackendText(::projectedBackendExplanation)
