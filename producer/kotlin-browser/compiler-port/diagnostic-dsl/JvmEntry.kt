/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.portable.diagnosticdsl.probe

import org.jetbrains.kotlin.cli.CliDiagnostics
import org.jetbrains.kotlin.config.*
import org.jetbrains.kotlin.diagnostics.*

private fun runtimeObservation(): String {
    val renderers = ProbeRenderers()
    val container = ProbeContainer(renderers)
    container.values().forEach { renderers.MAP.put(it, "message:{0}") }
    val rows = mutableListOf<String>()
    val factories = container.values() + CliDiagnostics.Messages.MAP.factories.map { it as KtSourcelessDiagnosticFactory }
    for (factory in factories) for (level in listOf(null, WarningLevel.Error, WarningLevel.Warning, WarningLevel.Disabled)) {
        val settings = LanguageVersionSettingsImpl(LanguageVersion.KOTLIN_2_2, ApiVersion.KOTLIN_2_2,
            analysisFlags = if (level == null) emptyMap() else mapOf(AnalysisFlags.warningLevels to mapOf(factory.name to level)))
        val context = object : DiagnosticBaseContext { override val languageVersionSettings = settings }
        val diagnostic = factory.create("actual 한😀 'message'", null, context)
        if (diagnostic == null) rows += "${factory.name}|$level|null"
        else {
            check(diagnostic.factory === factory && diagnostic.context === context && diagnostic.location == null)
            check(factory.rendererFactory(diagnostic) === factory.ktRenderer)
            rows += "${factory.name}|$level|${diagnostic.severity}|${diagnostic.renderMessage()}|${diagnostic.isValid}|${diagnostic.firstRange}"
        }
    }
    return rows.joinToString("\n", postfix = "\n")
}

fun main(args: Array<String>) { print(if (args.singleOrNull() == "runtime") runtimeObservation() else dslObservation()) }
