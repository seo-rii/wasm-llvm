package org.jetbrains.kotlin.js.sourcemaptextprobe

private class IoFault(label: String) : HostIoException(label)
private class RuntimeFault(label: String) : RuntimeException(label)

private interface Writer {
    fun append(value: String?)
    fun append(value: Char)
    fun flush()
    fun close()
    fun useAction(action: (Writer) -> Unit)
}
private interface Printer {
    fun print(value: String?)
    fun print(value: Char)
    fun println()
    fun flush()
    fun close()
    fun checkError(): Boolean
}
private interface ByteOutput {
    fun write(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size)
    fun close()
}
private interface FileView {
    val displayPath: String
    fun exists(): Boolean
    fun bytes(): ByteArray
    fun text(): String
    fun lines(): List<String>
    fun readerText(): String
    fun writer(): Writer
    fun output(): ByteOutput
}
private interface Store { fun file(path: String): FileView }

private class SinkState(val kind: Int, val writeAt: Int, val writeError: Int, val flushError: Int, val closeError: Int) {
    val faults = (0..2).map { if (kind == 0 || kind == 2 && it != 1 || kind == 3 && it == 1) IoFault("fault-$it") else RuntimeFault("fault-$it") }
    val calls = mutableListOf<String>()
    val bytes = mutableListOf<Byte>()
    private var writeCount = 0
    fun write(source: ByteArray, offset: Int, length: Int) {
        calls += "w$length"
        writeCount++
        if (writeCount == writeAt && writeError >= 0) throw faults[writeError]
        for (index in offset until offset + length) bytes += source[index]
    }
    fun flush() { calls += "f"; if (flushError >= 0) throw faults[flushError] }
    fun close() { calls += "c"; if (closeError >= 0) throw faults[closeError] }
    fun result(error: Throwable?): String {
        fun describe(value: Throwable?): String {
            val index = faults.indexOfFirst { it === value }
            return when {
                value == null -> "ok"
                index >= 0 -> "fault-$index"
                value is IllegalArgumentException -> "argument:${value.message}:${faults.indexOfFirst { it === value.cause }}"
                else -> "unexpected:${value.message}"
            }
        }
        val graph = faults.joinToString("/") { fault -> fault.suppressedExceptions.joinToString(".") { describe(it) } }
        return "${describe(error)}:$graph:${calls.joinToString(".")}:${hex(bytes.toByteArray())}"
    }
}
private fun hex(bytes: ByteArray): String = bytes.joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }
private fun units(text: String): String = text.map { it.code.toString(16).padStart(4, '0') }.joinToString("")
private fun escaped(value: String): String = buildString {
    append('"')
    for (char in value) when (char) { '"' -> append("\\\""); '\\' -> append("\\\\"); else -> if (char.code < 32) append("\\u" + char.code.toString(16).padStart(4, '0')) else append(char) }
    append('"')
}

fun observation(): String {
    val records = mutableListOf<String>()
    // Identity-sharing fault matrices preserve action/body/flush/close precedence.
    for (kind in 0..3) for (writeAt in 0..2) for (writeError in -1..2) for (flushError in -1..2) for (closeError in -1..2) for (actionError in -1..2) {
        val state = SinkState(kind, writeAt, writeError, flushError, closeError)
        val output = writer(state)
        val error = try {
            output.useAction {
                it.append("first-😀-")
                it.flush()
                it.append('\ud800')
                it.append("tail-\udc00")
                if (actionError >= 0) throw state.faults[actionError]
            }
            null
        } catch (failure: Throwable) { failure }
        output.close()
        records += "writer-$kind-$writeAt-$writeError-$flushError-$closeError-$actionError:" + state.result(error)
    }
    for (kind in 0..3) for (autoFlush in listOf(false, true)) for (writeAt in 0..3) for (writeError in -1..2) for (flushError in -1..2) for (closeError in -1..2) {
        val state = SinkState(kind, writeAt, writeError, flushError, closeError)
        val output = printer(state, autoFlush)
        var check: Boolean? = null
        val error = try {
            output.print("a\ud800")
            output.print('\udc00')
            output.print("\ud800b")
            output.println()
            check = output.checkError()
            output.close()
            output.close()
            output.print("closed")
            null
        } catch (failure: Throwable) { failure }
        records += "print-$kind-$autoFlush-$writeAt-$writeError-$flushError-$closeError:$check:" + state.result(error)
    }
    for ([payloadIndex, payload] in listOf("汉".repeat(8191) + "\ud800", "\ud800" + "a".repeat(16385) + "\udc00").withIndex()) {
        for (kind in 0..3) for (writeAt in 1..3) for (flushError in listOf(-1, 0)) for (closeError in listOf(-1, 1)) {
            val state = SinkState(kind, writeAt, 0, flushError, closeError)
            val output = writer(state)
            val error = try { output.useAction { it.append(payload) }; null } catch (failure: Throwable) { failure }
            output.close()
            records += "overflow-body-$payloadIndex-$kind-$writeAt-$flushError-$closeError:" + state.result(error)
        }
    }
    for (operation in 0..2) {
        val state = SinkState(0, 0, -1, -1, -1)
        val output = writer(state)
        output.close()
        val error = try { when (operation) { 0 -> output.append("closed"); 1 -> output.flush(); else -> output.close() }; null } catch (failure: Throwable) { failure }
        records += "closed-writer-$operation:${error is HostIoException}:${error?.message}:" + state.calls.joinToString(".")
    }
    for (kind in 0..3) {
        val state = SinkState(kind, 1, 0, -1, -1)
        val output = writer(state)
        output.append("x")
        val firstError = try { output.flush(); null } catch (failure: Throwable) { failure }
        val nextError = try { output.append("😀"); output.flush(); output.close(); null } catch (failure: Throwable) { failure }
        records += "small-failed-buffer-recovery-$kind:${firstError === state.faults[0]}:" + state.result(nextError)
    }
    val allUnits = buildString { for (code in 0..65535) { append(code.toChar()); append('\n') } }
    val state = SinkState(0, 0, -1, -1, -1)
    val output = writer(state)
    output.useAction { for (char in allUnits) it.append(char) }
    records += "all-utf16-writer:" + hex(state.bytes.toByteArray())
    records += "all-utf16-print:" + units(capture { it.print(allUnits) })
    for (size in listOf(0, 1, 2, 8191, 8192, 8193, 16383, 16384, 16385)) {
        val value = "a".repeat(size) + "😀\ud800"
        for (chunks in listOf(1, 2, 7, 8191, 8192, 8193)) {
            val s = SinkState(0, 0, -1, -1, -1)
            writer(s).useAction { w -> var start = 0; while (start < value.length) { val end = minOf(value.length, start + chunks); w.append(value.substring(start, end)); start = end }; w.flush(); w.append('\udc00') }
            records += "chunks-$size-$chunks:" + hex(s.bytes.toByteArray()) + ":" + s.calls.joinToString(".")
        }
    }
    for (value in listOf("", "\ud800", "\udc00", "a\ud800b", "\ud800\udc00", "\ufeffx\r\ny\r\nz\n")) {
        records += "debug-byte-capture:${units(value)}:" + units(capture { it.print(value) })
        records += "debug-char-capture:${units(value)}:" + units(capture { p -> for (char in value) p.print(char); p.println() })
    }
    val initial = linkedMapOf("a" to byteArrayOf(0xef.toByte(), 0xbb.toByte(), 0xbf.toByte(), 65, 13, 10, 66, 13, 67, 10, 10), "bad" to byteArrayOf(0xe1.toByte(), 0x80.toByte(), 65))
    val files = store(initial)
    initial.getValue("a")[0] = 0
    val a = files.file("a")
    val old = a.bytes(); old[0] = 0
    records += "file-copy:${a.exists()}:${hex(a.bytes())}:${units(a.text())}:${a.lines().joinToString("/") { units(it) }}:${units(a.readerText())}"
    records += "file-bad:${units(files.file("bad").text())}"
    for (text in listOf("", "\n", "\r", "\r\n", "a\n", "a\n\n", "a\rb\r\n\nc", "\ufeff")) {
        val file = files.file("lines"); file.output().also { it.write(utf8(text)); it.close() }
        records += "lines-${units(text)}:" + file.lines().joinToString("/") { units(it) }
    }
    val missing = files.file("missing")
    records += "file-create:${missing.exists()}"
    val buffered = missing.writer()
    records += "file-truncate:${missing.exists()}:${hex(missing.bytes())}"
    buffered.append("pending")
    records += "file-before-close:" + hex(missing.bytes())
    buffered.close()
    records += "file-after-close:" + hex(missing.bytes())
    missing.writer().close()
    records += "file-unchanged-overwrite:" + hex(missing.bytes())
    val first = missing.output(); first.write(byteArrayOf(1, 2, 3))
    val second = missing.output()
    first.write(byteArrayOf())
    records += "file-empty-after-truncate:" + hex(missing.bytes())
    second.write(byteArrayOf(9))
    first.write(byteArrayOf())
    records += "file-empty-keeps-other-writer:" + hex(missing.bytes())
    first.write(byteArrayOf(4)); first.close(); second.close()
    records += "file-open-cursor-after-truncate:" + hex(missing.bytes())
    for ([offset, length] in listOf(0 to 0, 1 to 0, -1 to 0, 0 to -1, 0 to 1)) {
        val error = try { first.write(byteArrayOf(), offset, length); null } catch (failure: Throwable) { failure }
        val kind = when (error) { null -> "ok"; is HostIoException -> "io:${error.message}"; is IndexOutOfBoundsException -> "bounds"; else -> "unexpected:${error.message}" }
        records += "file-closed-empty-range-$offset-$length:$kind:" + hex(missing.bytes())
    }
    val closedWriteError = try { first.write(byteArrayOf(5)); null } catch (failure: Throwable) { failure }
    records += "file-closed-nonempty:${closedWriteError is HostIoException}:${closedWriteError?.message}:" + hex(missing.bytes())
    return "{\"records\":[" + records.joinToString(",") { escaped(it) } + "],\"fullParserRuntimeBuilt\":false}"
}
