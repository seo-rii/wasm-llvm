package org.jetbrains.kotlin.js.sourcemappathprobe

import java.io.File
import java.io.Reader
import java.io.StringReader
import java.util.function.Supplier
import org.jetbrains.kotlin.js.sourceMap.*
import org.jetbrains.kotlin.js.backend.ast.*

private typealias PathValue = File
private typealias ProbeReader = Reader
private fun path(value: String): File = File(value)
private fun joined(parent: String, child: String): File = File(File(parent),child)
private fun cwd(): String = System.getProperty("user.dir")
private fun newReader(text: String): Reader = StringReader(text)
private fun resolver(roots: List<String>, output: String?, include: Boolean): SourceFilePathResolver = SourceFilePathResolver(roots.map(::File),output?.let(::File),include)
private fun resolveIfExists(resolver: SourceFilePathResolver, value: String, present: Boolean, log: MutableList<String>): String? =
    resolver.getPathRelativeToSourceRootsIfExists(object: File(value) { override fun exists(): Boolean { log.add(value);return present } })
private fun createResolver(roots: List<String>, prefix: String, output: String?, include: Boolean): SourceFilePathResolver = SourceFilePathResolver.create(roots,prefix,output?.let(::File),include)
private fun newBuilder(column: () -> Int): SourceMap3Builder = SourceMap3Builder(null,column,"")
private fun newConsumer(base: String, mapping: SourceMapMappingConsumer, resolver: SourceFilePathResolver, external: Boolean): SourceMapBuilderConsumer = SourceMapBuilderConsumer(File(base),mapping,resolver,external)
private fun recorder(events: MutableList<String>, throwAt: Int = -1): SourceMapMappingConsumer = object: SourceMapMappingConsumer {
    private var calls = 0
    private fun event(text: String) { events.add(text); if (calls++ == throwAt) throw IllegalStateException("mapping callback") }
    override fun newLine() = event("line")
    override fun addEmptyMapping() = event("empty")
    override fun addMapping(path: String, identity: Any?, content: Supplier<Reader?>, line: Int, column: Int, name: String?) {
        val text = content.get()?.use { it.readText() }
        event("map:${units(path)}:${identity}:${text?.let(::units)}:$line:$column:${name?.let(::units)}")
    }
}

@OptIn(org.jetbrains.kotlin.config.CompilerConfiguration.Internals::class)
private fun makeConfiguration(output: String?, roots: List<String>, include: Boolean, enabled: Boolean): org.jetbrains.kotlin.config.CompilerConfiguration = org.jetbrains.kotlin.config.CompilerConfiguration().also {
    val keys=org.jetbrains.kotlin.js.config.JSConfigurationKeys
    it.put(keys.SOURCE_MAP,enabled);it.put(keys.SOURCE_MAP_SOURCE_ROOTS,roots);it.put(keys.SOURCE_MAP_INCLUDE_MAPPINGS_FROM_UNAVAILABLE_FILES,include)
    if(output!=null)it.put(keys.OUTPUT_DIR,File(output))
}

private fun isExpectedNegativeLength(error: Throwable): Boolean = error is StringIndexOutOfBoundsException && error.message=="String index out of range: -1"
private fun isExpectedEmptyPop(error: Throwable): Boolean = error is IndexOutOfBoundsException && error.message=="Index -1 out of bounds for length 0"

private fun hostContracts(): List<String> = emptyList()
