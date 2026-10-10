package org.jetbrains.kotlin.js.sourcemapbuilderprobe

import org.jetbrains.kotlin.js.backend.ast.JsLocation
import org.jetbrains.kotlin.js.sourceMap.SourceMap3Builder
import org.jetbrains.kotlin.js.sourceMap.SourceMapMappingConsumer

private fun units(text: String): String = text.map { it.code.toString(16).padStart(4, '0') }.joinToString("")
private fun hex(bytes: List<Byte>): String = bytes.joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }
private fun quote(value: String): String = buildString {
    append('"')
    for (char in value) when (char) {
        '"' -> append("\\\"")
        '\\' -> append("\\\\")
        else -> if (char.code < 32 || char.code >= 127) append("\\u" + char.code.toString(16).padStart(4, '0')) else append(char)
    }
    append('"')
}
private fun failureText(error: Throwable): String = kind(error) + ":" + units(error.message ?: "<null>") +
    ":suppressed=" + error.suppressedExceptions.joinToString(",") { kind(it) + ":" + units(it.message ?: "<null>") }

private class Environment(val diagnosticsFailure: String = "", val sinkFailureKind: String = "") {
    val events = mutableListOf<String>()
    val bytes = mutableListOf<Byte>()
    val faults = mutableListOf<Throwable>()
    val observed = mutableListOf<Throwable>()
    lateinit var emitLine: (String) -> Unit
    val outputFault: Throwable? = when (sinkFailureKind) { "io" -> ioFailure("sink IO", this); "runtime" -> IllegalStateException("sink runtime"); else -> null }
    fun write(source: ByteArray, offset: Int, length: Int) {
        outputFault?.let { throw it }
        for (index in offset until offset + length) bytes.add(source[index])
    }
    fun banner(message: String) {
        events.add("banner:" + units(message))
        if (diagnosticsFailure == "banner") throw IllegalStateException("banner failure")
        if (diagnosticsFailure == "banner-error") throw AssertionError("banner Error")
        emitLine(message)
    }
    fun report(error: Throwable) {
        events.add("report:" + failureText(error))
        observed.add(error)
        if (diagnosticsFailure == "report") throw IllegalStateException("report failure")
        if (diagnosticsFailure == "report-error") throw AssertionError("report Error")
        emitLine("fixture throwable: " + failureText(error))
    }
    fun snapshot(): String = events.joinToString("|") + ":bytes=" + hex(bytes) +
        ":identity=" + observed.joinToString(",") { error -> faults.indexOfFirst { it === error }.toString() }
}
private class StableIdentity(val value: Int, private val hash: Int) {
    override fun hashCode(): Int = hash
    override fun equals(other: Any?): Boolean = other is StableIdentity && other.value == value
}
private fun fault(type: String, role: String, env: Environment): Throwable? = when (type) {
    "io" -> ioFailure(role + " IO", env)
    "runtime" -> IllegalStateException(role + " runtime")
    "error" -> AssertionError(role + " Error")
    else -> null
}.also { if (it != null) env.faults.add(it) }

private class PlannedReader(
    private val text: String,
    private val env: Environment,
    private val label: String,
    private val readFailure: Throwable?,
    private val closeFailure: Throwable?,
    private val chunk: Int,
    private var zeros: Int = 0,
    private val eof: Int = -1,
    private val readFailureAt: Int = 1,
) : ProbeReader() {
    private var position = 0
    private var calls = 0
    override fun read(buffer: CharArray, offset: Int, length: Int): Int {
        env.events.add("read:$label:${buffer.size}:$offset:$length:$position")
        if (++calls == readFailureAt) readFailure?.let { throw it }
        if (zeros-- > 0) return 0
        if (position == text.length) return eof
        val count = minOf(chunk, length, text.length - position)
        for (index in 0 until count) buffer[offset + index] = text[position + index]
        position += count
        return count
    }
    override fun close() {
        env.events.add("close:$label")
        closeFailure?.let { throw it }
    }
}
private fun supplier(env: Environment, label: String, text: String?, read: Throwable? = null, close: Throwable? = null,
    chunk: Int = 8192, zeros: Int = 0, eof: Int = -1, readFailureAt: Int = 1): ProbeSupplier = ProbeSupplier {
    env.events.add("supply:$label")
    text?.let { PlannedReader(it, env, label, read, close, chunk, zeros, eof, readFailureAt) }
}
private fun capture(env: Environment, action: () -> String): String = withKernelOutput(env) {
    try { "success:" + units(action()) } catch (error: Throwable) {
        "failure:" + failureText(error) + ":faultIdentity=" + env.faults.indexOfFirst { it === error }
    }
}

fun observation(): String {
    val records = mutableListOf<String>(); val rawFailures = mutableListOf<String>()
    for (name in listOf<String?>(null, "", "out.js", "€🙂.js")) {
        val env = Environment(); val builder = newBuilder(name, { 0 }, "", env)
        records.add("empty-${units(name ?: "<null>")}:" + capture(env) { builder.build() } + ":" + env.snapshot())
    }
    val paths = listOf("a.kt", "dir/a.kt", "dir/b.kt", "/a/b/c.kt", "/a/b/d.kt", "/a/b", "\\windows\\path.kt", JsLocation.IGNORED.file,
        "quote\"\\newline\n.kt", "raw\ud800.kt", "😀/two.kt", "")
    for (prefix in listOf("", "/prefix/", "https://example.invalid/root/")) for (count in 0..paths.size) {
        val env = Environment(); val builder = newBuilder(null, { 0 }, prefix, env)
        for (path in paths.take(count)) builder.addIgnoredSource(path)
        records.add("prefix-${units(prefix)}-$count:" + capture(env) { builder.build() })
    }
    for (identityMode in 0..3) {
        val env = Environment(); val builder = newBuilder(null, { 0 }, "", env)
        val keys: List<Any?> = when (identityMode) {
            0 -> listOf(null, null, null)
            1 -> listOf(StableIdentity(1, 7), StableIdentity(1, 7), StableIdentity(1, 7))
            2 -> listOf(StableIdentity(1, 7), StableIdentity(2, 7), StableIdentity(3, 7))
            else -> listOf("Aa", "BB", "Aa")
        }
        for ([index, key] in keys.withIndex()) {
            builder.addMapping("same.kt", index, index, index, name = "name-$index", fileIdentity = key,
                sourceContent = supplier(env, "identity-$index", "content-$index"))
        }
        records.add("identity-$identityMode:" + capture(env) { builder.build() } + ":" + env.snapshot())
        records.add("identity-repeat-$identityMode:" + capture(env) { builder.build() } + ":" + env.snapshot())
    }
    run {
        val env = Environment(); val builder = newBuilder(null, { 0 }, "", env)
        for (index in 0..128) {
            builder.addMapping("same.kt", index, 0, index, name = "key-$index", fileIdentity = StableIdentity(index, 0),
                sourceContent = supplier(env, "growth-$index", null))
            if (index in listOf(0, 8, 16, 24, 32, 64, 128)) records.add("collision-growth-$index:" + capture(env) { builder.build() } + ":" + env.snapshot())
        }
        for (index in 0..128) builder.addMapping("same.kt", index, 0, index, name = "key-$index", fileIdentity = StableIdentity(index, 0),
            sourceContent = supplier(env, "growth-loser-$index", "loser"))
        records.add("collision-growth-equal-key-winners:" + capture(env) { builder.build() } + ":" + env.snapshot())
    }
    val endpoints = listOf(Int.MIN_VALUE, Int.MIN_VALUE + 1, -8192, -33, -32, -1, 0, 1, 31, 32, 8192, Int.MAX_VALUE - 1, Int.MAX_VALUE)
    for (line in endpoints) for (column in endpoints) {
        val env = Environment(); val builder = newBuilder(null, { 0 }, "", env)
        builder.addMapping("x", line, column, column, name = "Aa")
        builder.addMapping("y", -line, -column, line, name = "BB")
        builder.newLine(); builder.addMapping("x", column, line, -column, name = "Aa")
        records.add("endpoints-$line-$column:" + capture(env) { builder.build() })
    }
    for (columns in listOf(listOf(0, 0, 0), listOf(0, 5, 5), listOf(10, 5, 3), listOf(-5, -5, 0), listOf(0, Int.MAX_VALUE, Int.MIN_VALUE), listOf(-1, 0, 1))) {
        val env = Environment(); var outputColumn = 0; val builder = newBuilder(null, { outputColumn }, "", env)
        for ([index, value] in columns.withIndex()) {
            outputColumn = value; builder.addMapping("x$index", index, index + 1, value, name = "n$index")
            records.add("rewind-${columns.joinToString(",")}-$index:" + capture(env) { builder.build() })
        }
        builder.addEmptyMapping(); builder.addEmptyMapping(); builder.newLine(); builder.addEmptyMapping()
        records.add("rewind-empty-${columns.joinToString(",")}:" + capture(env) { builder.build() })
    }
    run {
        val env = Environment(); var column = 0; val builder = newBuilder(null, { column }, "", env)
        val consumer: SourceMapMappingConsumer = builder
        consumer.addMapping("same.kt", null, supplier(env, "winner", "winner"), 1, 2, "initial")
        column = 4; consumer.addMapping("same.kt", null, supplier(env, "loser", "loser"), 1, 2, "allocated-but-suppressed")
        consumer.newLine(); column = 2; consumer.addMapping("same.kt", null, supplier(env, "third", "third"), 1, 2, "other-suppressed")
        records.add("duplicate-name-supplier:" + capture(env) { builder.build() } + ":" + env.snapshot())
        consumer.addMapping(JsLocation.IGNORED.file, null, supplier(env, "ignored", null), 0, 0, null)
        column = 3; consumer.addMapping(JsLocation.IGNORED.file, null, supplier(env, "ignored-loser", "bad"), 0, 0, null)
        records.add("ignored-not-suppressed:" + capture(env) { builder.build() } + ":" + env.snapshot())
    }
    var seed = 0x715b32
    fun next(bound: Int): Int { seed = seed * 1664525 + 1013904223; return (seed ushr 1) % bound }
    for (case in 0 until 500) {
        val env = Environment(); var column = 0; val builder = newBuilder(if (case % 7 == 0) "out.js" else null, { column }, if (case % 3 == 0) "/prefix/" else "", env)
        val identities = listOf(null, StableIdentity(1, 0), StableIdentity(2, 0), StableIdentity(1, 0))
        repeat(8 + case % 13) { step ->
            column = if (step % 7 == 0) endpoints[next(endpoints.size)] else next(16) - 3
            when (next(7)) {
                0 -> builder.newLine()
                1 -> builder.addEmptyMapping()
                2 -> builder.addIgnoredSource(paths[next(paths.size)], identities[next(identities.size)], supplier(env, "ignored-$step", "i$step"))
                else -> builder.addMapping(paths[next(paths.size)], next(16) - 3, next(16) - 3, column,
                    name = listOf<String?>(null, "Aa", "BB", "€", "")[next(5)], fileIdentity = identities[next(identities.size)],
                    sourceContent = supplier(env, "seed-$step", if (step % 3 == 0) null else "seed-content-$step"))
            }
        }
        records.add("seed-$case:" + capture(env) { builder.build() } + ":" + env.snapshot())
        records.add("seed-repeat-$case:" + capture(env) { builder.build() } + ":" + env.snapshot())
    }
    for (size in listOf(0, 1, 1023, 1024, 1025, 8191, 8192, 8193, 16385)) for (chunk in listOf(1, 7, 8192)) {
        val env = Environment(); val builder = newBuilder(null, { 0 }, "", env)
        val text = buildString { repeat(size) { append(('a'.code + it % 26).toChar()) }; append("\r\n\ud800x\udc00😀") }
        builder.addMapping("buffer", 0, 0, 0, sourceContent = supplier(env, "buffer", text, chunk = chunk, zeros = 1))
        records.add("buffer-$size-$chunk:" + capture(env) { builder.build() } + ":" + env.snapshot())
    }
    for (eof in listOf(-1, -2, Int.MIN_VALUE)) {
        val env = Environment(); val builder = newBuilder(null, { 0 }, "", env)
        builder.addMapping("eof", 0, 0, 0, sourceContent = supplier(env, "eof", "a", eof = eof))
        records.add("negative-eof-$eof:" + capture(env) { builder.build() } + ":" + env.snapshot())
    }
    for (readKind in listOf("", "io", "runtime", "error")) for (closeKind in listOf("", "io", "runtime", "error")) for (same in listOf(false, true)) {
        if (same && (readKind.isEmpty() || readKind != closeKind)) continue
        val env = Environment(); val read = fault(readKind, "read", env); val close = if (same) read else fault(closeKind, "close", env)
        val builder = newBuilder(null, { 0 }, "", env)
        builder.addMapping("failure", 0, 0, 0, sourceContent = supplier(env, "failure", "content", read, close))
        records.add("lifecycle-$readKind-$closeKind-$same:" + capture(env) { builder.build() } + ":" + env.snapshot())
    }
    for (readKind in listOf("io", "runtime", "error")) for (closeKind in listOf("", "io", "runtime", "error")) {
        val env = Environment(); val read = fault(readKind, "late read", env); val close = fault(closeKind, "close", env)
        val builder = newBuilder(null, { 0 }, "", env)
        builder.addMapping("late-failure", 0, 0, 0, sourceContent = supplier(env, "late-failure", "longer content", read, close, chunk = 3, readFailureAt = 3))
        records.add("late-lifecycle-$readKind-$closeKind:" + capture(env) { builder.build() } + ":" + env.snapshot())
    }
    for (mode in listOf("", "banner", "report", "banner-error", "report-error")) for (sink in listOf("", "io", "runtime")) {
        val env = Environment(mode, sink); val read = fault("io", "read", env); val builder = newBuilder(null, { 0 }, "", env)
        builder.addMapping("diagnostics", 0, 0, 0, sourceContent = supplier(env, "diagnostics", "", read))
        records.add("diagnostics-$mode-$sink:" + capture(env) { builder.build() } + ":" + env.snapshot())
    }
    run {
        val env = Environment(); val fail = fault("io", "supplier", env)!!; val builder = newBuilder(null, { 0 }, "", env)
        builder.addMapping("supplier", 0, 0, 0, sourceContent = ProbeSupplier { env.events.add("supply:throw"); throw fail })
        records.add("supplier-throws:" + capture(env) { builder.build() } + ":" + env.snapshot())
    }
    run {
        val env = Environment(); val builder = newBuilder(null, { 0 }, "", env)
        builder.addMapping("closed-native", 0, 0, 0, sourceContent = ProbeSupplier { closedReader() })
        records.add("closed-native-json:" + capture(env) { builder.build() })
        rawFailures.add("closed-native:" + env.snapshot())
    }
    run {
        val env = Environment(); val builder = newBuilder(null, { 0 }, "", env); val reader = actualStringReader("one reusable reader")
        builder.addMapping("reuse", 0, 0, 0, sourceContent = ProbeSupplier { reader })
        records.add("reused-reader-first-json:" + capture(env) { builder.build() })
        records.add("reused-reader-closed-json:" + capture(env) { builder.build() })
        rawFailures.add("reused-native:" + env.snapshot())
    }
    return "{\"records\":[" + records.joinToString(",") { quote(it) } + "],\"rawFailures\":[" + rawFailures.joinToString(",") { quote(it) } + "]}"
}
