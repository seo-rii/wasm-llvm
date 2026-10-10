package org.jetbrains.kotlin.js.sourcemapbuilderprobe

import org.jetbrains.kotlin.js.portable.CompilerByteSink
import org.jetbrains.kotlin.js.portable.sourcemap.*
import org.jetbrains.kotlin.js.sourceMap.SourceMap3Builder
import org.jetbrains.kotlin.js.util.AstReaderClosedException
import org.jetbrains.kotlin.js.util.AstSourceReader
import org.jetbrains.kotlin.js.util.AstStringReader

private typealias ProbeReader = AstSourceReader
private typealias ProbeSupplier = SourceMapContentSupplier
private fun ioFailure(message: String, env: Environment): Exception = SourceMapIoFailure(message)
private fun kind(error: Throwable): String = when (error) {
    is SourceMapIoFailure, is AstReaderClosedException -> "IO"
    is IllegalStateException -> "runtime"
    is AssertionError -> "Error"
    else -> error::class.simpleName ?: "Throwable"
}
private fun closedReader(): AstSourceReader = AstStringReader("closed").also { it.close() }
private fun actualStringReader(text: String): AstSourceReader = AstStringReader(text)
private fun newBuilder(name: String?, column: () -> Int, prefix: String, env: Environment): SourceMap3Builder =
    SourceMap3Builder(name, column, prefix, SourceMapBuilderHost('/', object : SourceMapEmbeddingDiagnostics {
        override fun println(message: String) = env.banner(message)
        override fun reportThrowable(failure: Throwable) = env.report(failure)
    }))
private fun <T> withKernelOutput(env: Environment, action: () -> T): T {
    val output = SourceMapPrintOutput(object : CompilerByteSink {
        override fun write(bytes: ByteArray, offset: Int, length: Int) = env.write(bytes, offset, length)
        override fun flush() {}
        override fun close() { error("Caller-owned output must remain open") }
    })
    env.emitLine = { output.print(it); output.print('\n') }
    return action()
}
