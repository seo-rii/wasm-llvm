package org.jetbrains.kotlin.portable.linkerprobe

import org.jetbrains.kotlin.library.SerializedIrFile
import org.jetbrains.kotlin.library.SerializedIrModule
import org.jetbrains.kotlin.library.SerializedMetadata
import org.jetbrains.kotlin.library.impl.IrArrayReader

/** Observers operate on genuine preexisting stdlib protobuf/table bytes, without producing Kotlin IR or code. */
fun writerData(files: Map<String, ByteArray>): Pair<SerializedMetadata, SerializedIrModule> {
    val module = files.getValue("default/linkdata/module")
    val groups = files.keys.filter { it.startsWith("default/linkdata/") && it.endsWith(".knm") }
        .groupBy { it.substringAfter("default/linkdata/").substringBefore('/') }
        .entries.sortedBy { it.key }
    val names = groups.map { if (it.key == "root_package") "" else it.key.removePrefix("package_") }
    val fragments = groups.map { it.value.sorted().map(files::getValue) }
    val metadata = SerializedMetadata(module, fragments, names, intArrayOf(2, 5, 0))
    fun ir(folder: String): List<SerializedIrFile> {
        val prefix = "default/$folder/"
        if (prefix + "files.knf" !in files) return emptyList()
        fun rows(name: String) = IrArrayReader(files.getValue(prefix + name))
        val irFiles = rows("files.knf")
        val declarations = rows("irDeclarations.knd")
        val bodies = rows("bodies.knb")
        val types = rows("types.knt")
        val signatures = rows("signatures.knt")
        val strings = rows("strings.knt")
        val debugInfo = files[prefix + "debugInfo.knd"]?.let(::IrArrayReader)
        val entries = files[prefix + "fileEntries.knf"]?.let(::IrArrayReader)
        return List(irFiles.entryCount()) { index -> SerializedIrFile(
            irFiles.tableItemBytes(index), "", index.toString().padStart(6, '0'),
            types.tableItemBytes(index), signatures.tableItemBytes(index), strings.tableItemBytes(index),
            bodies.tableItemBytes(index), declarations.tableItemBytes(index), debugInfo?.tableItemBytes(index), entries?.tableItemBytes(index),
        ) }.reversed() // Force the real writer to restore path order, for both main/inlinable tables.
    }
    return metadata to SerializedIrModule(null, ir("ir"), ir("ir_inlinable_functions"))
}

/** Binary observer format only: sorted file paths/content and explicit directories, each length-prefixed. */
fun outputSnapshot(files: Map<String, ByteArray>, directories: List<String>): ByteArray {
    val entries = files.entries.sortedBy { it.key }
    val paths = entries.map { it.key.encodeToByteArray() }
    val dirs = directories.sorted().map { it.encodeToByteArray() }
    val size = 8L + entries.sumOf { it.value.size.toLong() } + paths.sumOf { it.size.toLong() + 8 } + dirs.sumOf { it.size.toLong() + 4 }
    require(size <= 64 * 1024 * 1024)
    val output = ByteArray(size.toInt())
    var cursor = 0
    fun integer(value: Int) { for (shift in listOf(24, 16, 8, 0)) output[cursor++] = (value ushr shift).toByte() }
    fun bytes(value: ByteArray) { integer(value.size); value.copyInto(output, cursor); cursor += value.size }
    integer(entries.size)
    entries.forEachIndexed { index, entry -> bytes(paths[index]); bytes(entry.value) }
    integer(dirs.size)
    dirs.forEach(::bytes)
    check(cursor == output.size)
    return output
}

fun jarManifestCases(): List<Pair<String, ByteArray>> {
    fun case(name: String, text: String) = name to text.encodeToByteArray()
    return listOf(
        case("empty", ""),
        case("basic-crlf", "Manifest-Version: 1.0\r\nImplementation-Version: 2.5.0-dev-10106\r\n\r\n"),
        case("lf", "Implementation-Version: 2.5.0\n\n"),
        case("bare-cr", "Implementation-Version: 2.5.0\r\r"),
        case("crlf-continuation", "Implementation-Version: 2.5.\r\n 0\r\n\r\n"),
        case("case-insensitive", "implementation-version: 2.5.0\n\n"),
        case("duplicate-last", "Implementation-Version: 2.4.0\nImplementation-Version: 2.5.0\n\n"),
        case("continuation", "Implementation-Version: 2.5.\n 0-dev-10106\n\n"),
        case("empty-value", "Implementation-Version: \n\n"),
        case("leading-space-value", "Implementation-Version:  2.5.0\n\n"),
        case("main-section-only", "Manifest-Version: 1.0\n\nName: child\nImplementation-Version: 9.0.0\n\n"),
        case("named-extra-sections", "Implementation-Version: 2.5.0\n\nName: a\nX-Test: A\n\nName: b\nX-Test: B\n\n"),
        case("unterminated-line", "Implementation-Version: ignored"),
        case("unterminated-continuation", "Implementation-Version: 2.5.0\n ignored"),
        case("unterminated-after-header", "Implementation-Version: 2.5.0\nIgnored: unfinished"),
        case("unterminated-orphan-continuation", " unfinished"),
        case("header-without-blank", "Implementation-Version: 2.5.0\n"),
        case("cr-in-value", "Implementation-Version: 2.5.0\rtrailing\n\n"),
        case("unicode", "Implementation-Version: 한글😀\n\n"),
        case("max-name", "x".repeat(70) + ": value\nImplementation-Version: 2.5.0\n\n"),
        case("extra-empty-sections", "Implementation-Version: 2.5.0\n\n\nName: x\nX-Test: yes\n\n"),
        case("missing-colon", "Implementation-Version 2.5.0\n\n"),
        case("missing-colon-space", "Implementation-Version:2.5.0\n\n"),
        case("empty-name", ": value\n\n"),
        case("invalid-name", "Bad Name: value\n\n"),
        case("overlong-name", "x".repeat(71) + ": value\n\n"),
        case("orphan-continuation", " orphan\n\n"),
        case("missing-section-name", "Manifest-Version: 1.0\n\nX-Test: value\n\n"),
        "split-utf8-continuation" to ("Implementation-Version: ".encodeToByteArray() + byteArrayOf(0xe2.toByte(), 10, 32, 0x82.toByte(), 0xac.toByte(), 10, 10)),
        "invalid-utf8" to ("Implementation-Version: ".encodeToByteArray() + byteArrayOf(0xff.toByte(), 10, 10)),
    )
}

fun jarObservation(read: (ByteArray) -> String?): String = jarManifestCases().joinToString("\n") { [name, bytes] ->
    name + ":" + try { read(bytes)?.let { value -> "value:" + value.toCharArray().joinToString("") { it.code.toString(16).padStart(4, '0') } } ?: "absent" }
    catch (_: Exception) { "error" }
}
