@file:OptIn(kotlin.js.ExperimentalJsExport::class)
package org.jetbrains.kotlin.portable.firnavigation.probe

@kotlin.js.JsExport
fun firNavigationSnapshot(): String = navigationSnapshot()

fun main() {}
