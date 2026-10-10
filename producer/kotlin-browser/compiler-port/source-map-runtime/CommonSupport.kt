package org.jetbrains.kotlin.js.sourcemapruntimeprobe
import org.jetbrains.kotlin.js.backend.ast.*
import org.jetbrains.kotlin.js.parser.sourcemaps.*
import org.jetbrains.kotlin.js.portable.CompilerByteSink
import org.jetbrains.kotlin.js.portable.sourcemap.*
import org.jetbrains.kotlin.portable.text.compilerUtf8Bytes
private class Sink(val state: PrintState) : CompilerByteSink {
    override fun write(bytes: ByteArray, offset: Int, length: Int) = state.write(bytes, offset, length)
    override fun flush() { state.calls += "flush" }
    override fun close() { state.calls += "close" }
}
private typealias HostIoFailure = SourceMapIoFailure
private fun runtime(initial: Map<String, ByteArray>, state: PrintState) = SourceMapRuntime(SourceMapTextStore(initial), SourceMapPrintOutput(Sink(state)))
private fun parse(content: String, runtime: SourceMapRuntime) = SourceMapParser.parse(content, runtime)
private fun parseFile(path: String, runtime: SourceMapRuntime) = SourceMapParser.parse(runtime.files.file(path), runtime)
private fun debug(map: SourceMap, runtime: SourceMapRuntime) = map.debug()
private fun debugVerbose(map: SourceMap, runtime: SourceMapRuntime, path: String) = map.debugVerbose(runtime.printOutput, runtime.files.file(path))
private fun replaceSources(runtime: SourceMapRuntime, path: String, mapping: (String) -> String) = SourceMap.replaceSources(runtime.files.file(path), mapping)
private fun bytes(runtime: SourceMapRuntime, path: String) = runtime.files.file(path).readBytes()
private fun mapSources(content: String, mapping: (String) -> String): Pair<Boolean, String> { val result = StringBuilder(); return SourceMap.mapSources(content, result, mapping) to result.toString() }
private fun checkPrintError(runtime: SourceMapRuntime) = runtime.printOutput.checkError()
private fun utf8(text: String) = text.compilerUtf8Bytes()
private fun failureType(error: Throwable) = error::class.simpleName ?: "<anonymous>"
