/* Observe actual compiler message models and dispatch; no replacement compiler types. */
package org.jetbrains.kotlin.portable.messages.probe

import org.jetbrains.kotlin.cli.common.messages.*

fun observeMessages(): String {
    val observations = mutableListOf<String>()
    fun record(id: String, value: Any?) { observations.add("$id=$value") }
    fun names(values: Iterable<CompilerMessageSeverity>) = values.joinToString(",") { it.name }
    fun failed(block: () -> Unit): String = try { block(); "returned" } catch (_: NoSuchElementException) {
        "NoSuchElementException"
    } catch (_: IllegalStateException) { "IllegalStateException" }

    for (severity in CompilerMessageSeverity.entries) {
        record("severity:${severity.name}", "${severity.isError}/${severity.isWarning}/${severity.isRegularWarning}/${severity.presentableName}")
    }
    val verbose = CompilerMessageSeverity.VERBOSE
    val before = verbose.toList()
    for (mask in 0 until (1 shl CompilerMessageSeverity.entries.size)) {
        verbose.clear()
        for (value in CompilerMessageSeverity.entries.reversed()) {
            if (mask and (1 shl value.ordinal) != 0) verbose.add(value)
        }
        val expected = CompilerMessageSeverity.entries.filter { mask and (1 shl it.ordinal) != 0 }.toSet()
        record("set:$mask", "${names(verbose)}/${verbose.size}/${verbose == expected}/${verbose.hashCode() == expected.hashCode()}/${verbose.containsAll(expected)}")
    }
    verbose.clear()
    verbose.addAll(listOf(CompilerMessageSeverity.WARNING, CompilerMessageSeverity.ERROR))
    val iterator = verbose.iterator()
    record("iterator:remove-before-next", failed { iterator.remove() })
    record("iterator:first", iterator.next().name)
    verbose.clear()
    verbose.add(CompilerMessageSeverity.INFO)
    record("iterator:removed-snapshot-next", iterator.next().name)
    iterator.remove()
    record("iterator:second-remove", failed { iterator.remove() })
    record("iterator:exhausted", failed { iterator.next() })
    record("iterator:live-set", names(verbose))
    record("set:retain", verbose.retainAll(setOf(CompilerMessageSeverity.ERROR)))
    record("set:remove-absent", verbose.remove(CompilerMessageSeverity.ERROR))
    verbose.clear()
    verbose.addAll(before)

    val paths: List<String?> = listOf(null, "", "Main.kt", "dir/한글.kt", "a\\b.kt", "\uFEFF.kt")
    val locations = mutableListOf<CompilerMessageSourceLocation?>()
    for ([index, path] in paths.withIndex()) {
        val plain = CompilerMessageLocation.create(path)
        val point = CompilerMessageLocation.create(path, 2, 4, "한글\uD83D\uDE00")
        val range = CompilerMessageLocationWithRange.create(path, 2, 4, 3, 8, "\r\n")
        val open = CompilerMessageLocationWithRange.create(path, -1, 4, null, null, null)
        locations.add(point)
        record("location:$index", listOf(plain, point, range, open).joinToString("|") { value ->
            if (value == null) "null" else "${value.path}/${value.line}/${value.column}/${value.lineEnd}/${value.columnEnd}/${value.lineContent}/$value"
        })
        record("location:equal:$index", point == CompilerMessageLocation.create(path, 2, 4, "한글\uD83D\uDE00"))
        record("location:hash:$index", point?.hashCode() == CompilerMessageLocation.create(path, 2, 4, "한글\uD83D\uDE00")?.hashCode())
    }

    val collector = MessageCollectorImpl()
    record("collector:empty", "${collector.hasErrors()}/${collector.errors.size}/${collector.messages.size}")
    for (severity in CompilerMessageSeverity.entries) collector.report(severity, "text:${severity.name}", locations[3])
    record("collector:order", collector.messages.joinToString("|") { "${it.severity.name}:${it.location}:${it.message}" })
    record("collector:errors", "${collector.hasErrors()}/${names(collector.errors.map { it.severity })}")
    record("collector:render", collector.toString())
    val forwarded = MessageCollectorImpl()
    collector.forward(forwarded)
    record("collector:forward", collector.messages == forwarded.messages)
    collector.clear()
    record("collector:clear", "${collector.hasErrors()}/${collector.messages.size}/${forwarded.messages.size}")

    val calls = mutableListOf<String>()
    val withId = object : MessageCollectorWithDiagnosticId {
        override fun clear() { calls.add("clear") }
        override fun hasErrors() = false
        override fun report(severity: CompilerMessageSeverity, message: String, location: CompilerMessageSourceLocation?, diagnosticId: String?) {
            calls.add("${severity.name}/$message/$location/$diagnosticId")
        }
    }
    withId.report(CompilerMessageSeverity.ERROR, "plain", null)
    val erased: MessageCollector = withId
    erased.report(CompilerMessageSeverity.WARNING, "typed", locations[2], diagnosticId = "TYPE_MISMATCH")
    forwarded.report(CompilerMessageSeverity.ERROR, "fallback", null, diagnosticId = "INTERNAL")
    record("collector:diagnostic-id", calls.joinToString("|"))
    record("collector:without-id", forwarded.messages.last().toString())
    MessageCollector.NONE.report(CompilerMessageSeverity.ERROR, "ignored", null)
    MessageCollector.NONE.clear()
    record("collector:official-none", MessageCollector.NONE.hasErrors())

    // Escaped record separators keep source text (including CRLF) unchanged.
    return observations.joinToString("\n") { it.replace("\\", "\\\\").replace("\r", "\\r").replace("\n", "\\n") }
}
