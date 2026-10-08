/*
 * Browser host entry for the pinned official Kotlin compiler source port.
 * The parser, resolution, checkers and FIR2IR algorithms remain upstream code.
 */
package org.jetbrains.kotlin.browser.compiler

import org.jetbrains.kotlin.KtSourceFile
import org.jetbrains.kotlin.toSourceLinesMapping
import org.jetbrains.kotlin.builtins.KotlinBuiltIns
import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.descriptors.impl.ModuleDescriptorImpl
import org.jetbrains.kotlin.diagnostics.impl.BaseDiagnosticsCollector
import org.jetbrains.kotlin.fir.FirBinaryDependenciesModuleData
import org.jetbrains.kotlin.fir.FirSourceModuleData
import org.jetbrains.kotlin.fir.analysis.checkers.MppCheckerKind
import org.jetbrains.kotlin.fir.backend.Fir2IrConfiguration
import org.jetbrains.kotlin.fir.backend.Fir2IrExtensions
import org.jetbrains.kotlin.fir.backend.Fir2IrVisibilityConverter
import org.jetbrains.kotlin.fir.builder.MultiplatformParsing2Fir
import org.jetbrains.kotlin.fir.descriptors.FirModuleDescriptor
import org.jetbrains.kotlin.fir.deserialization.SingleModuleDataProvider
import org.jetbrains.kotlin.fir.pipeline.AllModulesFrontendOutput
import org.jetbrains.kotlin.fir.pipeline.Fir2IrActualizedResult
import org.jetbrains.kotlin.fir.pipeline.SingleModuleFrontendOutput
import org.jetbrains.kotlin.fir.pipeline.convertToIrAndActualize
import org.jetbrains.kotlin.fir.pipeline.runCheckers
import org.jetbrains.kotlin.fir.pipeline.runPlatformCheckers
import org.jetbrains.kotlin.fir.pipeline.runResolution
import org.jetbrains.kotlin.fir.resolve.providers.firProvider
import org.jetbrains.kotlin.fir.resolve.providers.impl.FirProviderImpl
import org.jetbrains.kotlin.fir.session.FirWasmSessionFactory
import org.jetbrains.kotlin.fir.session.KmpModuleKind
import org.jetbrains.kotlin.fir.session.sourcesToPathsMapper
import org.jetbrains.kotlin.ir.backend.js.lower.serialization.ir.JsManglerIr
import org.jetbrains.kotlin.ir.types.IrTypeSystemContextImpl
import org.jetbrains.kotlin.library.KotlinLibrary
import org.jetbrains.kotlin.library.isWasmStdlib
import org.jetbrains.kotlin.library.metadata.DeserializedKlibModuleOrigin
import org.jetbrains.kotlin.library.metadata.KlibModuleOrigin
import org.jetbrains.kotlin.library.uniqueName
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.platform.js.JsPlatforms
import org.jetbrains.kotlin.platform.wasm.WasmPlatforms
import org.jetbrains.kotlin.portable.descriptors.*
import org.jetbrains.kotlin.storage.LockBasedStorageManager

/** A user error keeps the collected official diagnostics and produces no IR artifact. */
class SourceCompilationFailed(val diagnostics: BaseDiagnosticsCollector) : Exception("Kotlin compilation failed")

class BrowserFrontendResult(
    val output: AllModulesFrontendOutput,
    val ir: Fir2IrActualizedResult,
)

/**
 * A request-local compiler entry. The caller supplies the approved configuration,
 * actual read-only KLIB readers and a fresh official diagnostic collector.
 *
 * This bypasses KotlinCoreEnvironment, PSI, ServiceLoader and JVM source discovery.
 * It is currently being connected to the portable KLIB/link/backend host; a
 * FIR2IR result alone is not a successful program or public browser compiler.
 */
class BrowserCompilerFrontend(
    private val configuration: CompilerConfiguration,
    private val targetLibraries: List<KotlinLibrary>,
) {
    fun compileFrontend(
        sources: List<KtSourceFile>,
        diagnosticReporter: BaseDiagnosticsCollector,
    ): BrowserFrontendResult {
        require(sources.isNotEmpty()) { "At least one source file is required" }
        require(sources.map { it.path ?: it.name }.toSet().size == sources.size) { "Duplicate source path" }
        require(targetLibraries.count { it.isWasmStdlib } == 1) { "Exactly one approved target stdlib is required" }

        val mainName = Name.special("<browser-program>")
        val factory = FirWasmSessionFactory.WasmWasi
        val registrars = emptyList<org.jetbrains.kotlin.fir.extensions.FirExtensionRegistrar>()
        val sharedLibrarySession = factory.createSharedLibrarySession(mainName, configuration, registrars)
        val binaryModule = FirBinaryDependenciesModuleData(Name.special("<browser-target-libraries>"))
        factory.createLibrarySession(
            targetLibraries,
            sharedLibrarySession,
            SingleModuleDataProvider(binaryModule),
            registrars,
            configuration,
        )
        val sourceModule = FirSourceModuleData(
            name = mainName,
            dependencies = listOf(binaryModule),
            dependsOnDependencies = emptyList(),
            friendDependencies = emptyList(),
            platform = WasmPlatforms.wasmWasi,
        )
        val session = factory.createSourceSession(
            sourceModule,
            registrars,
            configuration,
            KmpModuleKind.SingleModule,
            icData = null,
            init = {},
        )
        val provider = session.firProvider as FirProviderImpl
        val builder = MultiplatformParsing2Fir(session, provider.kotlinScopeProvider, diagnosticReporter)
        val firFiles = sources.map { source ->
            val code = source.getContentsAsText()
            builder.buildFirFile(code, source, code.toSourceLinesMapping()).also { file ->
                if (!diagnosticReporter.hasErrors) {
                    provider.recordFile(file)
                    session.sourcesToPathsMapper.registerFileSource(file.source!!, source.path ?: source.name)
                }
            }
        }
        if (diagnosticReporter.hasErrors) throw SourceCompilationFailed(diagnosticReporter)
        val [scopeSession, resolvedFiles] = session.runResolution(firFiles)
        session.runCheckers(scopeSession, resolvedFiles, diagnosticReporter, MppCheckerKind.Common)
        val frontendOutput = SingleModuleFrontendOutput(session, scopeSession, resolvedFiles)
        listOf(frontendOutput).runPlatformCheckers(diagnosticReporter)
        if (diagnosticReporter.hasErrors) throw SourceCompilationFailed(diagnosticReporter)

        // Keep the upstream WebFir2IrPipelinePhase descriptor/builtins construction
        // and its complete convertToIrAndActualize pipeline. Only plugin discovery
        // is excluded by the browser profile's empty explicit extension lists.
        var builtIns: KotlinBuiltIns? = null
        val dependencies = mutableListOf<ModuleDescriptorImpl>()
        val descriptors = targetLibraries.map { library ->
            val storage = LockBasedStorageManager("ModulesStructure")
            val moduleBuiltIns = builtIns ?: object : KotlinBuiltIns(storage) {}
            val descriptor = ModuleDescriptorImpl(
                Name.special("<${library.uniqueName}>"),
                storage,
                moduleBuiltIns,
                capabilities = mapOf(KlibModuleOrigin.CAPABILITY to DeserializedKlibModuleOrigin(library)),
                platform = JsPlatforms.defaultJsPlatform,
            )
            if (builtIns == null) moduleBuiltIns.builtInsModule = descriptor
            dependencies += descriptor
            descriptor.setDependencies(ArrayList(dependencies))
            if (library.isWasmStdlib) builtIns = descriptor.builtIns
            descriptor
        }
        val output = AllModulesFrontendOutput(listOf(frontendOutput))
        val ir = output.convertToIrAndActualize(
            Fir2IrExtensions.Default,
            Fir2IrConfiguration.forKlibCompilation(configuration, diagnosticReporter),
            irGeneratorExtensions = emptyList(),
            irMangler = JsManglerIr,
            visibilityConverter = Fir2IrVisibilityConverter.Default,
            kotlinBuiltIns = requireNotNull(builtIns),
            typeSystemContextProvider = ::IrTypeSystemContextImpl,
            createSpecialAnnotationsProvider = null,
            extraActualDeclarationExtractorsInitializer = { emptyList() },
        ) { module ->
            (module.descriptor as? FirModuleDescriptor)?.allDependencyModules = descriptors
        }
        if (diagnosticReporter.hasErrors) throw SourceCompilationFailed(diagnosticReporter)
        return BrowserFrontendResult(output, ir)
    }
}
