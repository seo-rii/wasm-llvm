package org.jetbrains.kotlin.portable.diagnosticfactories.probe

import org.jetbrains.kotlin.config.LanguageFeature
import org.jetbrains.kotlin.diagnostics.*
import org.jetbrains.kotlin.diagnostics.rendering.BaseDiagnosticRendererFactory

internal fun factories(name: String, severity: Severity, renderers: BaseDiagnosticRendererFactory): List<KtDiagnosticFactoryN> = listOf(
    KtDiagnosticFactory0(name + "0", severity, SourceElementPositioningStrategies.DEFAULT, renderers),
    KtDiagnosticFactory1<String>(name + "1", severity, SourceElementPositioningStrategies.DEFAULT, renderers),
    KtDiagnosticFactory2<String, Int>(name + "2", severity, SourceElementPositioningStrategies.DEFAULT, renderers),
    KtDiagnosticFactory3<String, Int, Boolean>(name + "3", severity, SourceElementPositioningStrategies.DEFAULT, renderers),
    KtDiagnosticFactory4<String, Int, Boolean, List<String?>>(name + "4", severity, SourceElementPositioningStrategies.DEFAULT, renderers),
)

internal fun deprecationFactories(renderers: BaseDiagnosticRendererFactory): List<KtDiagnosticFactoryForDeprecation<*>> = listOf(
    KtDiagnosticFactoryForDeprecation0("D0", LanguageFeature.ProhibitVarInJsModuleFile, SourceElementPositioningStrategies.DEFAULT, renderers),
    KtDiagnosticFactoryForDeprecation1<String>("D1", LanguageFeature.ProhibitVarInJsModuleFile, SourceElementPositioningStrategies.DEFAULT, renderers),
    KtDiagnosticFactoryForDeprecation2<String, Int>("D2", LanguageFeature.ProhibitVarInJsModuleFile, SourceElementPositioningStrategies.DEFAULT, renderers),
    KtDiagnosticFactoryForDeprecation3<String, Int, Boolean>("D3", LanguageFeature.ProhibitVarInJsModuleFile, SourceElementPositioningStrategies.DEFAULT, renderers),
    KtDiagnosticFactoryForDeprecation4<String, Int, Boolean, List<String?>>("D4", LanguageFeature.ProhibitVarInJsModuleFile, SourceElementPositioningStrategies.DEFAULT, renderers),
)

internal fun verifyMetadataVariant() { check(KtDiagnosticFactoryN::class.java.declaredMethods.none { it.name == "getPsiType" }) }
