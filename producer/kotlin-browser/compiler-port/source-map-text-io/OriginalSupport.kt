package org.jetbrains.kotlin.js.sourcemaptextprobe
import java.io.*
import java.nio.file.Files
private typealias HostIoException = IOException
private class Sink(val state: SinkState) : OutputStream() {
    override fun write(value: Int) = state.write(byteArrayOf(value.toByte()), 0, 1)
    override fun write(bytes: ByteArray, offset: Int, length: Int) = state.write(bytes, offset, length)
    override fun flush() = state.flush()
    override fun close() = state.close()
}
private class WriterAdapter(val value: BufferedWriter) : Writer {
    override fun append(value: String?) { this.value.append(value) }
    override fun append(value: Char) { this.value.append(value) }
    override fun flush() = value.flush()
    override fun close() = value.close()
    override fun useAction(action: (Writer) -> Unit) { value.use { action(this) } }
}
private class PrinterAdapter(val value: PrintStream) : Printer {
    override fun print(value: String?) = this.value.print(value)
    override fun print(value: Char) = this.value.print(value)
    override fun println() = value.println()
    override fun flush() = value.flush()
    override fun close() = value.close()
    override fun checkError() = value.checkError()
}
private fun writer(state: SinkState): Writer = WriterAdapter(BufferedWriter(OutputStreamWriter(Sink(state), Charsets.UTF_8)))
private fun printer(state: SinkState, autoFlush: Boolean): Printer = PrinterAdapter(PrintStream(Sink(state), autoFlush, Charsets.UTF_8))
private fun capture(action: (Printer) -> Unit): String {
    val bytes = ByteArrayOutputStream()
    action(PrinterAdapter(PrintStream(bytes, false, Charsets.UTF_8)))
    return bytes.toString(Charsets.UTF_8)
}
private fun utf8(value: String) = value.toByteArray(Charsets.UTF_8)
private fun store(initial: Map<String, ByteArray>): Store {
    val directory = Files.createTempDirectory("source-map-text-io-").toFile()
    for ([name, bytes] in initial) File(directory, name).writeBytes(bytes)
    return object : Store {
        override fun file(path: String): FileView {
            val file = File(directory, path)
            return object : FileView {
                override val displayPath get() = path
                override fun exists() = file.exists()
                override fun bytes() = file.readBytes()
                override fun text() = file.readText(Charsets.UTF_8)
                override fun lines() = file.readLines(Charsets.UTF_8)
                override fun readerText(): String = file.reader(Charsets.UTF_8).use { it.readText() }
                override fun writer(): Writer = WriterAdapter(file.writer(Charsets.UTF_8).buffered())
                override fun output(): ByteOutput {
                    val output = FileOutputStream(file)
                    return object : ByteOutput { override fun write(bytes: ByteArray, offset: Int, length: Int) = output.write(bytes, offset, length); override fun close() = output.close() }
                }
            }
        }
    }
}
