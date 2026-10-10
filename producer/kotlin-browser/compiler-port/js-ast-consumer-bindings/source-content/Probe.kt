@file:OptIn(org.jetbrains.kotlin.config.CompilerConfiguration.Internals::class)
package org.jetbrains.kotlin.js.sourcecontentprobe

import org.jetbrains.kotlin.KtInMemoryTextSourceFile
import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.js.backend.ast.JsLocation
import org.jetbrains.kotlin.js.portable.installRequestSourceContent
import org.jetbrains.kotlin.js.portable.requestSourceSupplier

fun String.utf16(): String = map { it.code.toString(16).padStart(4, '0') }.joinToString("")
private fun quote(text: String): String = "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r") + "\""
fun observation(): String {
    val records = ArrayList<String>(); val failures = ArrayList<String>()
    fun record(name: String, value: Any?) { records.add("$name=$value") }
    val configuration = CompilerConfiguration(); val other = CompilerConfiguration()
    val originalLocation = JsLocation("A.kt", 7, 11, "named")
    val unavailable = originalLocation.withEmbeddedSource(configuration)
    record("absent", unavailable.sourceProvider() == null)
    val text = "\uFEFFα\r\n한\n😀\u0000tail"
    val sources = arrayListOf(KtInMemoryTextSourceFile("fallback.kt", null, "fallback\r\n"), KtInMemoryTextSourceFile("A.kt", "A.kt", text),
        KtInMemoryTextSourceFile("alias", "/src/../A.kt", "spelled"), KtInMemoryTextSourceFile("empty", "", ""), KtInMemoryTextSourceFile("nul", "nul\u0000.kt", "nul-key"))
    installRequestSourceContent(configuration, sources)
    val location = originalLocation.withEmbeddedSource(configuration)
    record("location", "${location.file}/${location.startLine}/${location.startChar}/${location.name}/${location.fileIdentity}")
    record("simple.identity", location.asSimpleLocation() === originalLocation)
    val first = location.sourceProvider()!!; val second = location.sourceProvider()!!
    record("fresh.identity", first !== second)
    record("first.char", first.read())
    record("second.full", second.readText().utf16())
    record("first.remaining", first.readText().utf16())
    record("first.eof", first.read())
    second.close()
    try { second.read(); error("Expected closed reader") } catch (error: Throwable) { record("closed", error.message); failures.add("closed:${error::class.simpleName}:${error.message}") }
    record("fresh.afterclose", location.sourceProvider()!!.readText().utf16())
    for (path in listOf("fallback.kt", "A.kt", "/src/../A.kt", "", "nul\u0000.kt", "src/A.kt", "missing"))
        record("lookup.${path.utf16()}", requestSourceSupplier(configuration, path)()?.readText()?.utf16())
    record("other.empty", requestSourceSupplier(other, "A.kt")() == null)
    sources.clear()
    record("snapshot.afterlistclear", location.sourceProvider()!!.readText().utf16())
    val copied = configuration.copy()
    installRequestSourceContent(configuration, listOf(KtInMemoryTextSourceFile("A.kt", "A.kt", "new")))
    record("captured.old", location.sourceProvider()!!.readText().utf16())
    record("current.new", originalLocation.withEmbeddedSource(configuration).sourceProvider()!!.readText().utf16())
    record("copy.old", requestSourceSupplier(copied, "A.kt")()!!.readText().utf16())
    record("absent.staysabsent", unavailable.sourceProvider() == null)
    installRequestSourceContent(other, listOf(KtInMemoryTextSourceFile("A.kt", "A.kt", "other")))
    record("other.independent", requestSourceSupplier(other, "A.kt")()!!.readText().utf16())
    record("current.independent", requestSourceSupplier(configuration, "A.kt")()!!.readText().utf16())
    try { installRequestSourceContent(configuration, listOf(KtInMemoryTextSourceFile("same", null, "one"), KtInMemoryTextSourceFile("different", "same", "two"))); error("Expected duplicate path") }
    catch (error: Throwable) { record("duplicate", error::class.simpleName); record("duplicate.message", error.message) }
    record("duplicate.atomic", requestSourceSupplier(configuration, "A.kt")()!!.readText().utf16())
    configuration.isReadOnly = true
    try { installRequestSourceContent(configuration, listOf(KtInMemoryTextSourceFile("A.kt", "A.kt", "forbidden"))); error("Expected read-only configuration") }
    catch (error: Throwable) { record("readonly", error::class.simpleName); record("readonly.message", error.message) }
    record("readonly.atomic", requestSourceSupplier(configuration, "A.kt")()!!.readText().utf16())
    val counted = MutableInput("counted", null, "captured\r\n")
    installRequestSourceContent(other, listOf(counted))
    check(counted.reads == 1)
    val countedSupplier = requestSourceSupplier(other, "counted")
    counted.text = "changed"
    record("source.readonce", counted.reads)
    record("source.immutable", countedSupplier()!!.readText().utf16())
    record("source.fresh", countedSupplier() !== countedSupplier())
    record("source.notreread", counted.reads)
    counted.failRead = true
    try { installRequestSourceContent(other, listOf(counted)); error("Expected source failure") }
    catch (error: Throwable) { record("source.failure", error::class.simpleName); record("source.failure.message", error.message) }
    record("source.failure.atomic", requestSourceSupplier(other, "counted")()!!.readText().utf16())
    counted.failRead = false
    try { installRequestSourceContent(other, listOf(counted, counted)); error("Expected duplicate") }
    catch (error: Throwable) { record("source.duplicate", error::class.simpleName) }
    check(counted.reads == 3) // first snapshot, failed read, then first duplicate item; never read second duplicate
    record("source.duplicate.reads", counted.reads)
    record("source.duplicate.atomic", requestSourceSupplier(other, "counted")()!!.readText().utf16())
    return "{\"records\":[" + records.joinToString(",") { quote(it) } + "],\"failures\":[" + failures.joinToString(",") { quote(it) } + "]}"
}
