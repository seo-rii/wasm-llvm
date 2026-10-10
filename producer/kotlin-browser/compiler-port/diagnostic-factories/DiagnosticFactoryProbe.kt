@file:Suppress("UNCHECKED_CAST")
@file:OptIn(org.jetbrains.kotlin.diagnostics.InternalDiagnosticFactoryMethod::class)

package org.jetbrains.kotlin.portable.diagnosticfactories.probe

import org.jetbrains.kotlin.KtMissingSourceElement
import org.jetbrains.kotlin.config.AnalysisFlags
import org.jetbrains.kotlin.config.ApiVersion
import org.jetbrains.kotlin.config.LanguageVersion
import org.jetbrains.kotlin.config.LanguageVersionSettings
import org.jetbrains.kotlin.config.LanguageVersionSettingsImpl
import org.jetbrains.kotlin.config.WarningLevel
import org.jetbrains.kotlin.diagnostics.*
import org.jetbrains.kotlin.diagnostics.rendering.BaseDiagnosticRendererFactory

private class ProbeRenderers : BaseDiagnosticRendererFactory() {
    override val MAP: KtDiagnosticFactoryToRendererMap by KtDiagnosticFactoryToRendererMap("actual-factory-probe") {}
}

private fun register(map: KtDiagnosticFactoryToRendererMap, factory: KtDiagnosticFactoryN) {
    when (factory) {
        is KtDiagnosticFactory0 -> map.put(factory, "zero")
        is KtDiagnosticFactory1<*> -> map.put(factory as KtDiagnosticFactory1<String>, "one:{0}", null)
        is KtDiagnosticFactory2<*, *> -> map.put(factory as KtDiagnosticFactory2<String, Int>, "two:{0}/{1}", null, null)
        is KtDiagnosticFactory3<*, *, *> -> map.put(factory as KtDiagnosticFactory3<String, Int, Boolean>, "three:{0}/{1}/{2}", null, null, null)
        is KtDiagnosticFactory4<*, *, *, *> -> map.put(factory as KtDiagnosticFactory4<String, Int, Boolean, List<String?>>, "four:{0}/{1}/{2}/{3}", null, null, null, null)
    }
}

private fun diagnostic(factory: KtDiagnosticFactoryN, missing: Boolean, overridePosition: Boolean, context: DiagnosticBaseContext): KtDiagnostic? {
    val element = if (missing) null else KtMissingSourceElement
    val position = if (overridePosition) SourceElementPositioningStrategies.NAME_IDENTIFIER else null
    return when (factory) {
        is KtDiagnosticFactory0 -> factory.onOrFallback(element, position, context)
        is KtDiagnosticFactory1<*> -> (factory as KtDiagnosticFactory1<String>).onOrFallback(element, "한😀", position, context)
        is KtDiagnosticFactory2<*, *> -> (factory as KtDiagnosticFactory2<String, Int>).onOrFallback(element, "한😀", 17, position, context)
        is KtDiagnosticFactory3<*, *, *> -> (factory as KtDiagnosticFactory3<String, Int, Boolean>).onOrFallback(element, "한😀", 17, false, position, context)
        is KtDiagnosticFactory4<*, *, *, *> -> (factory as KtDiagnosticFactory4<String, Int, Boolean, List<String?>>).onOrFallback(element, "한😀", 17, false, listOf("a", null, "😀"), position, context)
    }
}

private fun String.units(): String = map { it.code.toString(16).padStart(4, '0') }.joinToString(":")

private fun observe(block: () -> String): String = try { "ok:" + block().units() }
catch (error: Throwable) {
    when (error) {
        is IllegalArgumentException, is IllegalStateException, is UnsupportedOperationException, is ClassCastException ->
            error::class.java.name + ":" + error.message.orEmpty().units()
        else -> throw error
    }
}

private fun settings(factoryName: String, level: WarningLevel?): LanguageVersionSettings = LanguageVersionSettingsImpl(
    LanguageVersion.KOTLIN_2_2, ApiVersion.KOTLIN_2_2,
    analysisFlags = if (level == null) emptyMap() else mapOf(AnalysisFlags.warningLevels to mapOf(factoryName to level)),
)

fun main() {
    verifyMetadataVariant()
    val observations = mutableListOf<String>()
    for (severity in Severity.entries) {
        val renderers = ProbeRenderers()
        val values = factories("F_${severity.name}_", severity, renderers)
        values.forEach { register(renderers.MAP, it) }
        for (factory in values) for (level in listOf(null, WarningLevel.Error, WarningLevel.Warning, WarningLevel.Disabled)) {
            val context = object : DiagnosticBaseContext { override val languageVersionSettings = settings(factory.name, level) }
            observations += "severity|${factory.name}|$level|${factory.getEffectiveSeverity(context.languageVersionSettings)}"
            for (missing in listOf(false, true)) for (overridePosition in listOf(false, true)) {
                val value = diagnostic(factory, missing, overridePosition, context)
                val id = "${factory.name}|$level|missing=$missing|override=$overridePosition"
                if (value == null) { observations += "$id|null"; continue }
                check(value.context === context)
                val positioned = value as? KtDiagnosticWithSource
                if (positioned != null) {
                    check(positioned.element === KtMissingSourceElement)
                    check(positioned.positioningStrategy === if (overridePosition) SourceElementPositioningStrategies.NAME_IDENTIFIER else SourceElementPositioningStrategies.DEFAULT)
                    check(positioned.factory === factory)
                }
                observations += "$id|${value.factoryName}|${value.severity}|" + observe { value.renderMessage() }
                observations += "$id|range|" + observe { value.firstRange.toString() }
                observations += "$id|valid|" + observe { value.isValid.toString() }
                observations += "$id|renderer-identity|${factory.ktRenderer === factory.ktRenderer}|${factory.toString() == factory.name}"
            }
        }
    }
    val renderers = ProbeRenderers()
    for (pair in deprecationFactories(renderers)) {
        check(pair.warningFactory.name == pair.name + "_WARNING" && pair.errorFactory.name == pair.name + "_ERROR")
        check(pair.warningFactory.severity == Severity.WARNING && pair.errorFactory.severity == Severity.ERROR)
        check(pair.warningFactory.rendererFactory === renderers && pair.errorFactory.rendererFactory === renderers)
        register(renderers.MAP, pair.warningFactory); register(renderers.MAP, pair.errorFactory)
        observations += "deprecation|${pair.name}|${pair.deprecatingFeature}|${pair.warningFactory.name}|${pair.errorFactory.name}"
        for (factory in listOf(pair.warningFactory, pair.errorFactory)) for (missing in listOf(false, true)) {
            val value = diagnostic(factory, missing, false, DiagnosticContext.Default)!!
            observations += "pair|${factory.name}|$missing|${value.factoryName}|${value.severity}|" + observe { value.renderMessage() }
        }
    }
    val missingRenderer = factories("NO_RENDERER", Severity.ERROR, ProbeRenderers()).first()
    observations += "missing-renderer|" + observe { missingRenderer.ktRenderer.message }
    val duplicateRenderers = ProbeRenderers()
    val duplicate = factories("DUPLICATE", Severity.ERROR, duplicateRenderers).first()
    register(duplicateRenderers.MAP, duplicate)
    observations += "duplicate-renderer|" + observe { register(duplicateRenderers.MAP, duplicate); "unexpected-success" }
    for (severity in Severity.entries) for (level in listOf(null, WarningLevel.Error, WarningLevel.Warning, WarningLevel.Disabled)) {
        val sourceRenderers = ProbeRenderers()
        val factory = KtSourcelessDiagnosticFactory("SOURCELESS", severity, sourceRenderers)
        sourceRenderers.MAP.put(factory, "message:{0}")
        val context = object : DiagnosticBaseContext { override val languageVersionSettings = settings(factory.name, level) }
        val value = factory.create("한😀", null, context)
        if (value == null) observations += "sourceless|$severity|$level|null"
        else {
            check(value.context === context && value.location == null && value.factory === factory)
            observations += "sourceless|$severity|$level|${value.severity}|" + observe { value.renderMessage() }
        }
    }
    println("{\"observations\":[" + observations.joinToString(",") { "\"" + it.replace("\\", "\\\\").replace("\"", "\\\"") + "\"" } +
        "],\"diagnosticFactoryArities\":5,\"deprecationArities\":5,\"metadataVariantVerified\":true,\"wasmRuntime\":\"not-run\"}")
}
