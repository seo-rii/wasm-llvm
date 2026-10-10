package org.jetbrains.kotlin.js.sourcemaptextprobe
import org.jetbrains.kotlin.js.portable.CompilerByteSink
import org.jetbrains.kotlin.js.portable.sourcemap.*
import org.jetbrains.kotlin.portable.text.compilerUtf8Bytes
private typealias HostIoException = SourceMapIoFailure

private class Sink(val state: SinkState) : CompilerByteSink {
    override fun write(bytes: ByteArray, offset: Int, length: Int) = state.write(bytes, offset, length)
    override fun flush() = state.flush()
    override fun close() = state.close()
}
private class WriterAdapter(val value: SourceMapBufferedUtf8Writer) : Writer {
    override fun append(value: String?) { this.value.append(value) }
    override fun append(value: Char) { this.value.append(value) }
    override fun flush() = value.flush()
    override fun close() = value.close()
    override fun useAction(action: (Writer) -> Unit) { value.useSourceMapWriter { action(this) } }
}
private class PrinterAdapter(val value: SourceMapPrintOutput) : Printer {
    override fun print(value: String?) = this.value.print(value)
    override fun print(value: Char) = this.value.print(value)
    override fun println() = value.println()
    override fun flush() = value.flush()
    override fun close() = value.close()
    override fun checkError() = value.checkError()
}
private fun writer(state: SinkState): Writer = WriterAdapter(SourceMapBufferedUtf8Writer(Sink(state)))
private fun printer(state: SinkState, autoFlush: Boolean): Printer = PrinterAdapter(SourceMapPrintOutput(Sink(state), autoFlush))
private fun capture(action: (Printer) -> Unit): String = captureSourceMapDebug { action(PrinterAdapter(it)) }
private fun utf8(value: String) = value.compilerUtf8Bytes()
private fun store(initial: Map<String, ByteArray>): Store {
    val value = SourceMapTextStore(initial)
    return object : Store {
        override fun file(path: String): FileView {
            val file = value.file(path)
            return object : FileView {
                override val displayPath get() = file.displayPath
                override fun exists() = file.exists()
                override fun bytes() = file.readBytes()
                override fun text() = file.readUtf8Text()
                override fun lines() = file.readLines()
                override fun readerText(): String { val reader = file.openReader(); try { return reader.readText() } finally { reader.close() } }
                override fun writer(): Writer = WriterAdapter(file.openBufferedWriter())
                override fun output(): ByteOutput {
                    val output = file.openOverwriteSink()
                    return object : ByteOutput { override fun write(bytes: ByteArray, offset: Int, length: Int) = output.write(bytes, offset, length); override fun close() = output.close() }
                }
            }
        }
    }
}
