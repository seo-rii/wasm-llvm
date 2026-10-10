/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.portable.diagnosticdsl.probe

import org.jetbrains.kotlin.cli.CliDiagnostics
import org.jetbrains.kotlin.diagnostics.*
import org.jetbrains.kotlin.diagnostics.rendering.BaseDiagnosticRendererFactory

class ProbeRenderers : BaseDiagnosticRendererFactory() {
    override val MAP: KtDiagnosticFactoryToRendererMap by KtDiagnosticFactoryToRendererMap("source-free-DSL") {}
}

class ProbeContainer(private val renderers: BaseDiagnosticRendererFactory) : KtDiagnosticsContainer() {
    var rendererRequests = 0
    val ERROR by errorWithoutSource()
    val WARNING by warningWithoutSource()
    val INFO by infoWithoutSource()
    val STRONG by strongWarningWithoutSource()
    val `한😀` by infoWithoutSource()
    override fun getRendererFactory(): BaseDiagnosticRendererFactory {
        rendererRequests++
        return renderers
    }
    fun values(): List<KtSourcelessDiagnosticFactory> = listOf(ERROR, WARNING, INFO, STRONG, `한😀`)
}

fun dslObservation(): String {
    val rows = mutableListOf<String>()
    fun record(name: String, value: Any?) { rows += "$name=$value" }
    fun failure(name: String, body: () -> Unit) {
        try { body(); record(name, "NO_EXCEPTION") }
        catch (error: IllegalStateException) { record(name, "${error::class.simpleName}:${error.message}") }
    }
    val renderer = ProbeRenderers()
    val first = ProbeContainer(renderer)
    val second = ProbeContainer(renderer)
    record("initialization.renderer-requests", first.rendererRequests)
    record("delegate.repeated-property-identity", first.ERROR === first.ERROR)
    record("duplicate-name.factory-identity", first.ERROR !== second.ERROR)
    record("duplicate-name.exact-name", first.ERROR.name == second.ERROR.name)
    for (container in listOf(first, second)) for (factory in container.values()) {
        check(factory.rendererFactory === renderer)
        record("factory.${factory.name}", "${factory.severity}/${factory.toString()}")
        renderer.MAP.put(factory, "message:{0}")
        check(renderer.MAP.containsKey(factory))
        check(renderer.MAP[factory] === factory.ktRenderer)
        record("renderer.${factory.name}", factory.ktRenderer.message)
    }
    failure("duplicate-renderer") { renderer.MAP.put(first.ERROR, "second") }
    val unregistered = ProbeContainer(ProbeRenderers())
    failure("missing-renderer") { unregistered.ERROR.ktRenderer }

    val cliFactories = CliDiagnostics.getRendererFactory().MAP.factories
    record("actual-CLI.factory-count", cliFactories.size)
    record("actual-CLI.unique-names", cliFactories.map { it.name }.toSet().size)
    check(cliFactories.all { it.rendererFactory === CliDiagnostics.Messages })
    for (factory in cliFactories) record("actual-CLI.${factory.name}", "${factory.severity}/${factory.ktRenderer.message}")

    val storage = KtRegisteredDiagnosticFactoriesStorage()
    storage.registerDiagnosticContainers(first, first, second)
    record("registration.shared-renderer-factories", storage.allDiagnosticFactories.size)
    check(storage.allDiagnosticFactories.toSet().size == 10)
    storage.registerDiagnosticContainers(listOf(CliDiagnostics, CliDiagnostics))
    record("registration.actual-CLI-and-shared", storage.allDiagnosticFactories.size)
    record("registration.same-name-distinct", storage.allDiagnosticFactories.count { it.name == "ERROR" })
    record("registration.repeat-stable", storage.allDiagnosticFactories == storage.allDiagnosticFactories)
    return rows.joinToString("\n", postfix = "\n")
}
