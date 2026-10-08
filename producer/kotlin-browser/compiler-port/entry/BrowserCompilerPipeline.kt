/* Official pipeline assembly for a fresh browser compiler request. */
package org.jetbrains.kotlin.browser.compiler

import org.jetbrains.kotlin.KtSourceFile
import org.jetbrains.kotlin.backend.common.linkage.issues.checkNoUnboundSymbols
import org.jetbrains.kotlin.backend.wasm.WasmBackendContext
import org.jetbrains.kotlin.backend.wasm.compileToLoweredIr
import org.jetbrains.kotlin.backend.wasm.dce.eliminateDeadDeclarations
import org.jetbrains.kotlin.backend.wasm.ic.IrFactoryImplForWasmIC
import org.jetbrains.kotlin.config.CommonConfigurationKeys
import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.config.languageVersionSettings
import org.jetbrains.kotlin.diagnostics.impl.BaseDiagnosticsCollector
import org.jetbrains.kotlin.fir.pipeline.Fir2KlibMetadataSerializer
import org.jetbrains.kotlin.ir.KtDiagnosticReporterWithImplicitIrBasedContext
import org.jetbrains.kotlin.ir.backend.js.ModulesStructure
import org.jetbrains.kotlin.ir.backend.js.WholeWorldStageController
import org.jetbrains.kotlin.ir.backend.js.dce.DceDumpNameCache
import org.jetbrains.kotlin.ir.backend.js.loadIr
import org.jetbrains.kotlin.ir.backend.js.loadMemoryWebKlibs
import org.jetbrains.kotlin.ir.backend.js.serializeModuleIntoMemoryKlib
import org.jetbrains.kotlin.ir.backend.js.utils.JsMainFunctionDetector
import org.jetbrains.kotlin.ir.util.ExternalDependenciesGenerator
import org.jetbrains.kotlin.ir.util.patchDeclarationParents
import org.jetbrains.kotlin.js.config.dce
import org.jetbrains.kotlin.library.impl.BuiltInsPlatform
import org.jetbrains.kotlin.platform.wasm.WasmTarget
import org.jetbrains.kotlin.portable.linker.MemoryKlibInput
import org.jetbrains.kotlin.portable.linker.requireMemoryKlibFiles
import org.jetbrains.kotlin.portable.source.LibraryPath
import org.jetbrains.kotlin.wasm.config.WasmConfigurationKeys
import org.jetbrains.kotlin.wasm.config.wasmDisableCrossFileOptimisations

/** A console-profile user error, distinct from an internal compiler failure. */
class KotlinEntryRejected(val reasonCode: String, message: String) : Exception(message)

/**
 * Caller-owned approved configuration and immutable library indexes. The caller
 * must discard the Worker after an internal exception, trap or forced stop.
 * This entry has not built/executed yet; its actual dependencies are being ported.
 */
class BrowserCompilerPipeline(
    private val configuration: CompilerConfiguration,
    private val approvedInputs: List<MemoryKlibInput>,
    private val diagnostics: BaseDiagnosticsCollector,
) {
    fun compile(sources: List<KtSourceFile>, maximumArtifactBytes: Int): BrowserProgramBinary {
        require(configuration.get(WasmConfigurationKeys.WASM_TARGET) == WasmTarget.WASI)
        require(maximumArtifactBytes > 0)
        val moduleName = requireNotNull(configuration[CommonConfigurationKeys.MODULE_NAME])
        val loadedInputs = loadMemoryWebKlibs(configuration, approvedInputs, target = "wasm-wasi")
        if (diagnostics.hasErrors) throw SourceCompilationFailed(diagnostics)
        val frontend = BrowserCompilerFrontend(configuration, loadedInputs.all).compileFrontend(sources, diagnostics)

        // Keep the complete official source -> KLIB -> linked IR boundary. FIR
        // metadata needs the actual frontend files, not an empty placeholder.
        val outputPath = LibraryPath("/request/program.klib")
        require(approvedInputs.none { it.path == outputPath }) { "Program output collides with an approved input" }
        val metadata = Fir2KlibMetadataSerializer(
            configuration,
            firOutputs = frontend.output.outputs,
            fir2IrActualizedResult = frontend.ir,
            produceHeaderKlib = false,
        )
        val irDiagnostics = KtDiagnosticReporterWithImplicitIrBasedContext(diagnostics, configuration.languageVersionSettings)
        val library = serializeModuleIntoMemoryKlib(
            moduleName = moduleName,
            configuration = configuration,
            diagnosticReporter = irDiagnostics,
            metadataSerializer = metadata,
            klibPath = outputPath,
            moduleFragment = frontend.ir.irModuleFragment,
            irBuiltIns = frontend.ir.irBuiltIns,
            cleanFiles = emptyList(),
            jsOutputName = null,
            builtInsPlatform = BuiltInsPlatform.WASM,
            wasmTarget = WasmTarget.WASI,
            performanceManager = null,
        )
        if (diagnostics.hasErrors) throw SourceCompilationFailed(diagnostics)
        val inputs = approvedInputs + MemoryKlibInput(outputPath, library.requireMemoryKlibFiles())
        val linkedLibraries = loadMemoryWebKlibs(configuration, inputs, target = "wasm-wasi", included = outputPath)
        if (diagnostics.hasErrors) throw SourceCompilationFailed(diagnostics)
        val structure = ModulesStructure(outputPath.value, configuration, linkedLibraries)
        val factory = IrFactoryImplForWasmIC(WholeWorldStageController())
        val loadedIr = loadIr(structure, factory)
        val context = WasmBackendContext(loadedIr.bultins, loadedIr.symbolTable, loadedIr.module, configuration)
        val linker = loadedIr.deserializer

        // Preserve the upstream WasmIrLinkingPipelinePhase order and invariants.
        ExternalDependenciesGenerator(loadedIr.symbolTable, listOf(linker)).generateUnboundSymbolsAsDependencies()
        val dependencies = linker.moduleDependencyTracker.reverseTopoOrder(loadedIr.dependencies)
        val modules = dependencies.allDependencies
        modules.forEach { it.patchDeclarationParents() }
        linker.postProcess(loadedIr.bultins, inOrAfterLinkageStep = true)
        linker.checkNoUnboundSymbols(loadedIr.symbolTable, "at the end of IR linkage process")
        linker.clear()

        // Use the official detector on analyzed IR. The first console profile
        // requires one ordinary no-argument main and rejects ambiguous entries.
        val detector = JsMainFunctionDetector(context)
        val entries = loadedIr.module.files.mapNotNull { detector.getMainFunctionOrNull(it) }
        if (entries.size != 1) throw KotlinEntryRejected("CONSOLE_ENTRY_COUNT", "Exactly one Kotlin main entry is required")
        if (entries.single().parameters.isNotEmpty() || entries.single().isSuspend) {
            throw KotlinEntryRejected("CONSOLE_ENTRY_SIGNATURE", "The console entry must be fun main()")
        }

        configuration.wasmDisableCrossFileOptimisations = false // official whole-program mode
        val lowered = compileToLoweredIr(configuration, linker, modules, context)
        if (configuration.dce) eliminateDeadDeclarations(lowered.loweredIr, context, DceDumpNameCache())
        if (diagnostics.hasErrors) throw SourceCompilationFailed(diagnostics)
        val wasmIr = compileWholeProgramModeToWasmIr(configuration, factory, lowered)
        val artifact = writeBrowserProgramBinary(wasmIr, maximumArtifactBytes)
        if (diagnostics.hasErrors) throw SourceCompilationFailed(diagnostics)
        return artifact
    }
}
