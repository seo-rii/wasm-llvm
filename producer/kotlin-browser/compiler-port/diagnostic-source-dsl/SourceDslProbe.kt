/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.portable.diagnosticsourcedsl.probe

import com.intellij.psi.PsiElement
import org.jetbrains.kotlin.backend.common.CommonBackendErrors
import org.jetbrains.kotlin.backend.common.actualizer.IrActualizationErrors
import org.jetbrains.kotlin.backend.common.diagnostics.SerializationErrors
import org.jetbrains.kotlin.config.*
import org.jetbrains.kotlin.diagnostics.*
import org.jetbrains.kotlin.diagnostics.rendering.BaseDiagnosticRendererFactory
import org.jetbrains.kotlin.ir.backend.js.checkers.JsKlibErrors
import org.jetbrains.kotlin.ir.backend.js.wasm.WasmKlibErrors
import org.jetbrains.kotlin.ir.inline.diagnostics.IrInlinerErrors

private class ProbeRenderers : BaseDiagnosticRendererFactory() {
    override val MAP by KtDiagnosticFactoryToRendererMap("source-DSL-probe") {}
}

private class ProbeContainer : KtDiagnosticsContainer() {
    private val renderers = ProbeRenderers()
    val W0 by warning0<PsiElement>()
    val SW1 by strongWarning1<PsiElement, String>()
    val W1 by warning1<PsiElement, String>()
    val SW2 by strongWarning2<PsiElement, String, Int>()
    val W2 by warning2<PsiElement, String, Int>()
    val W3 by warning3<PsiElement, String, Int, Boolean>()
    val W4 by warning4<PsiElement, String, Int, Boolean, List<String?>>()
    val E0 by error0<PsiElement>(SourceElementPositioningStrategies.NAME_IDENTIFIER)
    val E1 by error1<PsiElement, String>()
    val E2 by error2<PsiElement, String, Int>()
    val E3 by error3<PsiElement, String, Int, Boolean>()
    val E4 by error4<PsiElement, String, Int, Boolean, List<String?>>()
    val D0 by deprecationError0<PsiElement>(LanguageFeature.ForbidCaptureInlinableLambdasInJsCode)
    val D1 by deprecationError1<PsiElement, String>(LanguageFeature.ForbidCaptureInlinableLambdasInJsCode)
    val D2 by deprecationError2<PsiElement, String, Int>(LanguageFeature.ForbidCaptureInlinableLambdasInJsCode)
    val D3 by deprecationError3<PsiElement, String, Int, Boolean>(LanguageFeature.ForbidCaptureInlinableLambdasInJsCode)
    val D4 by deprecationError4<PsiElement, String, Int, Boolean, List<String?>>(LanguageFeature.ForbidCaptureInlinableLambdasInJsCode)
    override fun getRendererFactory(): BaseDiagnosticRendererFactory = renderers
    fun values(): List<KtDiagnosticFactoryN> = listOf(W0, SW1, W1, SW2, W2, W3, W4, E0, E1, E2, E3, E4)
    fun pairs(): List<KtDiagnosticFactoryForDeprecation<*>> = listOf(D0, D1, D2, D3, D4)
}

fun main(args: Array<String>) {
    val original = args.single() == "original"
    val rows = mutableListOf<String>()
    fun record(name: String, value: Any?) {
        val escaped = value.toString().replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r")
        rows += "$name=$escaped"
    }
    fun factory(factory: AbstractKtDiagnosticFactory, renderers: BaseDiagnosticRendererFactory) {
        check(factory.rendererFactory === renderers)
        record("factory.${factory.name}", "${factory::class.simpleName}/${factory.severity}")
        if (factory is KtDiagnosticFactoryN) {
            val getter = factory::class.java.methods.singleOrNull { it.name == "getPsiType" }
            check((getter != null) == original)
            if (getter != null) check(getter.invoke(factory) == PsiElement::class)
        }
    }
    val probe = ProbeContainer()
    check(probe.W1 === probe.W1)
    for (value in probe.values()) {
        factory(value, probe.getRendererFactory())
        check(value.defaultPositioningStrategy === if (value === probe.E0) SourceElementPositioningStrategies.NAME_IDENTIFIER else SourceElementPositioningStrategies.DEFAULT)
        record("position.${value.name}", if (value === probe.E0) "NAME_IDENTIFIER" else "DEFAULT")
    }
    val actualPairs: List<KtDiagnosticFactoryForDeprecation<*>> = listOf(
        IrInlinerErrors.IR_PRIVATE_TYPE_USED_IN_NON_PRIVATE_INLINE_FUNCTION,
        IrInlinerErrors.IR_PRIVATE_TYPE_USED_IN_NON_PRIVATE_INLINE_FUNCTION_CASCADING,
        IrInlinerErrors.IR_PRIVATE_CALLABLE_REFERENCED_BY_NON_PRIVATE_INLINE_FUNCTION,
        IrInlinerErrors.IR_PRIVATE_CALLABLE_REFERENCED_BY_NON_PRIVATE_INLINE_FUNCTION_CASCADING,
        JsKlibErrors.JS_CODE_CAPTURES_INLINABLE_FUNCTION,
    )
    for (pair in probe.pairs() + actualPairs) {
        check(pair.warningFactory.name == pair.name + "_WARNING" && pair.errorFactory.name == pair.name + "_ERROR")
        check(pair.warningFactory.severity == Severity.WARNING && pair.errorFactory.severity == Severity.ERROR)
        record("pair.${pair.name}", "${pair::class.simpleName}/${pair.deprecatingFeature}/${pair.warningFactory.name}/${pair.errorFactory.name}")
        for (state in listOf(LanguageFeature.State.ENABLED, LanguageFeature.State.DISABLED)) {
            val settings = LanguageVersionSettingsImpl(LanguageVersion.KOTLIN_2_2, ApiVersion.KOTLIN_2_2,
                specificFeatures = mapOf(pair.deprecatingFeature to state))
            val context = object : DiagnosticContext {
                override val languageVersionSettings = settings
                override val containingFile = null
                override fun isDiagnosticSuppressed(diagnostic: KtDiagnostic): Boolean = false
            }
            val selected = with(context) { pair.chooseFactory() }
            check(selected === if (state == LanguageFeature.State.ENABLED) pair.errorFactory else pair.warningFactory)
            record("selection.${pair.name}.$state", "${selected.name}/${selected.severity}")
        }
    }
    val containers: List<KtDiagnosticsContainer> = listOf(CommonBackendErrors, IrActualizationErrors, IrInlinerErrors,
        SerializationErrors, JsKlibErrors, WasmKlibErrors)
    for (container in containers) {
        val renderers = container.getRendererFactory()
        val values = renderers.MAP.factories
        record("container.${container::class.simpleName}.size", values.size)
        check(values.map { it.name }.toSet().size == values.size)
        for (value in values) {
            factory(value, renderers)
            check(renderers.MAP[value] === value.ktRenderer)
            record("renderer.${value.name}", value.ktRenderer.message)
        }
    }
    check(CommonBackendErrors.NON_TAIL_RECURSIVE_CALL.defaultPositioningStrategy === SourceElementPositioningStrategies.REFERENCED_NAME_BY_QUALIFIED)
    check(CommonBackendErrors.NO_TAIL_CALLS_FOUND.defaultPositioningStrategy === SourceElementPositioningStrategies.TAILREC_MODIFIER)
    check(IrActualizationErrors.NO_ACTUAL_FOR_EXPECT.defaultPositioningStrategy === SourceElementPositioningStrategies.EXPECT_ACTUAL_MODIFIER)
    record("actual-positioning-preserved", true)
    val storage = KtRegisteredDiagnosticFactoriesStorage()
    storage.registerDiagnosticContainers(containers + containers)
    record("registered-actual-factories", storage.allDiagnosticFactories.size)
    check(storage.allDiagnosticFactories.size == containers.sumOf { it.getRendererFactory().MAP.factories.size })
    print(rows.joinToString("\n", postfix = "\n"))
}
