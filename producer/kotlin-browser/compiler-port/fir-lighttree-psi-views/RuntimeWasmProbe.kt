@file:OptIn(kotlin.js.ExperimentalJsExport::class)
package org.jetbrains.kotlin.portable.psiviews.probe

@kotlin.js.JsExport
fun psiViewsObservation(): String = psiViewsSnapshot()
