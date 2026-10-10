package org.jetbrains.kotlin.js.outputprobe

private class ProbeFailure(val label: String) : RuntimeException(label)

private class SinkState(val writeAt: Int, val writeError: Int, val flushError: Int, val closeError: Int) {
    val failures = listOf(ProbeFailure("A"), ProbeFailure("B"), ProbeFailure("C"))
    val calls = mutableListOf<String>()
    val bytes = mutableListOf<Int>()
    val backing = mutableListOf<String>()
    private val arrays = mutableListOf<ByteArray>()
    private var writeCount = 0
    fun write(source: ByteArray, offset: Int, length: Int) {
        calls += "write-$length"
        var identity = arrays.indexOfFirst { it === source }
        if (identity < 0) { identity = arrays.size; arrays += source }
        backing += "${source.size}-$offset-$length-$identity"
        writeCount++
        if (writeCount == writeAt && writeError >= 0) throw failures[writeError]
        for (index in offset until offset + length) bytes += source[index].toInt() and 255
    }
    fun flush() { calls += "flush"; if (flushError >= 0) throw failures[flushError] }
    fun close() { calls += "close"; if (closeError >= 0) throw failures[closeError] }
    fun result(error: Throwable?): String {
        val root = if (error == null) "ok" else failures.indexOfFirst { it === error }.toString()
        val graph = failures.joinToString("/") { failure -> failure.suppressedExceptions.joinToString(".") { suppressed ->
            failures.indexOfFirst { it === suppressed }.toString() } }
        return root + ":" + graph + ":" + calls.joinToString(".") + ":" + bytes.joinToString("") { it.toString(16).padStart(2, '0') }
    }
}

fun observation(): String {
    val records = mutableListOf<String>()
    val backings = mutableListOf<String>()
    for (writeAt in 0..5) for (writeError in -1..2) for (flushError in -1..2) for (closeError in -1..2) {
        val state = SinkState(writeAt, writeError, flushError, closeError)
        val error = try { SaveBoundary().saveTo(SelectedSink(state)); null } catch (failure: Throwable) { failure }
        records += "save-$writeAt-$writeError-$flushError-$closeError:" + state.result(error)
        backings += state.backing.joinToString("/")
    }
    for (actionError in -1..2) for (flushError in -1..2) for (closeError in -1..2) {
        val state = SinkState(0, -1, flushError, closeError)
        val output = lifecycle(state)
        val error = try {
            output.useAction { it.writeInt(Int.MIN_VALUE); if (actionError >= 0) throw state.failures[actionError] }
            null
        } catch (failure: Throwable) { failure }
        output.close()
        output.writeInt(Int.MAX_VALUE)
        records += "lifecycle-$actionError-$flushError-$closeError:" + state.result(error)
        backings += state.backing.joinToString("/")
    }
    return "{\"records\":[" + records.joinToString(",") { "\"$it\"" } + "],\"backings\":[" + backings.joinToString(",") { "\"$it\"" } + "]}"
}
