@file:OptIn(kotlin.js.ExperimentalJsExport::class)
package org.jetbrains.kotlin.portable.k1profile.probe
@kotlin.js.JsExport
fun retainedK1Observation(): String = observeRetainedK1Contracts()
