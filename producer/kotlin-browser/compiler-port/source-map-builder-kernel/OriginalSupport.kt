package org.jetbrains.kotlin.js.sourcemapbuilderprobe

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.io.PrintStream
import java.io.Reader
import java.io.StringReader
import java.util.function.Supplier
import org.jetbrains.kotlin.js.sourceMap.SourceMap3Builder

private typealias ProbeReader = Reader
private typealias ProbeSupplier = Supplier<Reader?>
private class FixtureIoFailure(message: String, private val env: Environment) : IOException(message) {
    override fun printStackTrace() = env.report(this)
}
private fun ioFailure(message: String, env: Environment): Exception = FixtureIoFailure(message, env)
private fun kind(error: Throwable): String = when (error) {
    is IOException -> "IO"
    is IllegalStateException -> "runtime"
    is AssertionError -> "Error"
    else -> error::class.simpleName ?: "Throwable"
}
private fun closedReader(): Reader = StringReader("closed").also { it.close() }
private fun actualStringReader(text: String): Reader = StringReader(text)
private fun newBuilder(name: String?, column: () -> Int, prefix: String, env: Environment): SourceMap3Builder {
    check(File.separatorChar == '/')
    return SourceMap3Builder(name?.let(::File), column, prefix)
}
private fun <T> withKernelOutput(env: Environment, action: () -> T): T {
    val previous = System.err
    val output = object : OutputStream() {
        override fun write(value: Int) = env.write(byteArrayOf(value.toByte()), 0, 1)
        override fun write(bytes: ByteArray, offset: Int, length: Int) = env.write(bytes, offset, length)
    }
    val actual = object : PrintStream(output, false, "UTF-8") {
        override fun println(message: String?) = env.banner(message ?: "null")
    }
    env.emitLine = { actual.print(it); actual.print('\n') }
    System.setErr(actual)
    try { return action() } finally { System.setErr(previous) }
}
