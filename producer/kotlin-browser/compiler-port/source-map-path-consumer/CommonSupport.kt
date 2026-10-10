package org.jetbrains.kotlin.js.sourcemappathprobe

import org.jetbrains.kotlin.js.portable.sourcemap.*
import org.jetbrains.kotlin.js.sourceMap.*
import org.jetbrains.kotlin.js.backend.ast.*
import org.jetbrains.kotlin.js.util.AstSourceReader
import org.jetbrains.kotlin.js.util.AstStringReader

private typealias PathValue = SourceMapPosixPath
private typealias ProbeReader = AstSourceReader
private var existsValue = false
private var existsLog: MutableList<String>? = null
private val host = SourceMapPathHost("__CURRENT_DIRECTORY__", { existsLog?.add(it.path); existsValue }, object: SourceMapEmbeddingDiagnostics {
    override fun println(message: String) { error("Unexpected embedding IO banner in this profile: $message") }
    override fun reportThrowable(failure: Throwable) { throw failure }
},null)
private fun path(value: String): SourceMapPosixPath = host.path(value)
private fun joined(parent: String, child: String): SourceMapPosixPath = host.join(host.path(parent),child)
private fun cwd(): String = host.workingDirectory.path
private fun newReader(text: String): AstSourceReader = AstStringReader(text)
private fun resolver(roots: List<String>, output: String?, include: Boolean): SourceFilePathResolver = SourceFilePathResolver(host,roots.map(host::path),output?.let(host::path),include)
private fun resolveIfExists(resolver: SourceFilePathResolver, value: String, present: Boolean, log: MutableList<String>): String? {
    existsValue=present;existsLog=log
    try { return resolver.getPathRelativeToSourceRootsIfExists(path(value)) } finally { existsLog=null }
}
private fun createResolver(roots: List<String>, prefix: String, output: String?, include: Boolean): SourceFilePathResolver = SourceFilePathResolver.create(host,roots,prefix,output?.let(host::path),include)
private fun newBuilder(column: () -> Int): SourceMap3Builder = SourceMap3Builder(null,column,"",host.builderHost)
private fun newConsumer(base: String, mapping: SourceMapMappingConsumer, resolver: SourceFilePathResolver, external: Boolean): SourceMapBuilderConsumer = SourceMapBuilderConsumer(path(base),mapping,resolver,external)
private fun recorder(events: MutableList<String>, throwAt: Int = -1): SourceMapMappingConsumer = object: SourceMapMappingConsumer {
    private var calls = 0
    private fun event(text: String) { events.add(text); if (calls++ == throwAt) throw IllegalStateException("mapping callback") }
    override fun newLine() = event("line")
    override fun addEmptyMapping() = event("empty")
    override fun addMapping(path: String, identity: Any?, content: SourceMapContentSupplier, line: Int, column: Int, name: String?) {
        val text = content.get()?.useSourceMapEmbeddingReader { it?.readSourceMapEmbeddingText() }
        event("map:${units(path)}:${identity}:${text?.let(::units)}:$line:$column:${name?.let(::units)}")
    }
}

@OptIn(org.jetbrains.kotlin.config.CompilerConfiguration.Internals::class)
private fun makeConfiguration(output: String?, roots: List<String>, include: Boolean, enabled: Boolean): org.jetbrains.kotlin.config.CompilerConfiguration = org.jetbrains.kotlin.config.CompilerConfiguration().also {
    val keys=org.jetbrains.kotlin.js.config.JSConfigurationKeys
    it.put(keys.SOURCE_MAP,enabled);it.put(keys.SOURCE_MAP_SOURCE_ROOTS,roots);it.put(keys.SOURCE_MAP_INCLUDE_MAPPINGS_FROM_UNAVAILABLE_FILES,include)
    installRequestSourceMapPathHost(it,SourceMapPathHost(cwd(), { file -> file.path == "producer/kotlin-browser/compiler-port/source-map-path-consumer/Probe.kt" },host.diagnostics,output))
}

private fun isExpectedNegativeLength(error: Throwable): Boolean =
    (error is IndexOutOfBoundsException && error.message=="String index out of range: -1") || (error is IllegalArgumentException && error.message=="Negative new length: -1.")
private fun isExpectedEmptyPop(error: Throwable): Boolean = error is IndexOutOfBoundsException && (error.message=="Index -1 out of bounds for length 0" || error.message=="index: -1, size: 0")

private fun hostContracts(): List<String> = observeVirtualPathHostContracts()
