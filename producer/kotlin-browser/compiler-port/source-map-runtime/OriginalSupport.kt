package org.jetbrains.kotlin.js.sourcemapruntimeprobe
import java.io.*
import java.nio.file.Files
import org.jetbrains.kotlin.js.backend.ast.*
import org.jetbrains.kotlin.js.parser.sourcemaps.*
import org.jetbrains.kotlin.js.portable.sourcemap.SourceMapRuntime
private typealias HostIoFailure = IOException
private class Sink(val state: PrintState) : OutputStream() {
    override fun write(value: Int) = state.write(byteArrayOf(value.toByte()), 0, 1)
    override fun write(bytes: ByteArray, offset: Int, length: Int) = state.write(bytes, offset, length)
    override fun flush() { state.calls += "flush" }
    override fun close() { state.calls += "close" }
}
private fun runtime(initial: Map<String, ByteArray>, state: PrintState): SourceMapRuntime {
    val root = Files.createTempDirectory("source-map-runtime-").toFile()
    for ([name, value] in initial) File(root, name).writeBytes(value)
    return SourceMapRuntime(root, PrintStream(Sink(state), false, Charsets.UTF_8))
}
private fun parse(content: String, runtime: SourceMapRuntime) = SourceMapParser.parse(content)
private fun parseFile(path: String, runtime: SourceMapRuntime) = SourceMapParser.parse(File(runtime.files, path))
// Explicit request writer is the oracle; no claim of original global System.out isolation.
private fun debug(map: SourceMap, runtime: SourceMapRuntime) = map.debug(runtime.printOutput)
private fun debugVerbose(map: SourceMap, runtime: SourceMapRuntime, path: String) = map.debugVerbose(runtime.printOutput, File(runtime.files, path))
private fun replaceSources(runtime: SourceMapRuntime, path: String, mapping: (String) -> String) = SourceMap.replaceSources(File(runtime.files, path), mapping)
private fun bytes(runtime: SourceMapRuntime, path: String) = File(runtime.files, path).readBytes()
private fun mapSources(content: String, mapping: (String) -> String): Pair<Boolean, String> { val result = StringWriter(); return SourceMap.mapSources(content, result, mapping) to result.toString() }
private fun checkPrintError(runtime: SourceMapRuntime) = runtime.printOutput.checkError()
private fun utf8(text: String) = text.toByteArray(Charsets.UTF_8)
private fun failureType(error: Throwable) = error.javaClass.name
