package org.jetbrains.kotlin.portable.klibprobe

import org.jetbrains.kotlin.library.*
import org.jetbrains.kotlin.library.components.*
import org.jetbrains.kotlin.library.encodings.WobblyTF8
import org.jetbrains.kotlin.library.impl.*

private fun ByteArray.hex(): String = joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }
private fun String.codeUnits(): String = map { it.code.toString(16).padStart(4, '0') }.joinToString("")

/** The same unchanged official format APIs are invoked on original JVM, portable JVM and browser Wasm. */
fun unitSnapshot(): String {
    val records = mutableListOf<String>()
    fun record(id: String, text: String) { records.add("\"$id\":\"$text\"") }
    val payloads = listOf(byteArrayOf(), byteArrayOf(0, -1, 127, -128), ByteArray(128) { it.toByte() }, ByteArray(16384) { (it * 31).toByte() })
    for (varInt in listOf(false, true)) {
        for (size in 0..payloads.size) {
            val data = payloads.take(size)
            val encoded = IrArrayWriter(data, varInt).writeIntoMemory()
            val reader = IrArrayReader(encoded)
            check(reader.entryCount() == data.size)
            for (index in data.indices) check(reader.tableItemBytes(index).contentEquals(data[index]))
            record("array-$varInt-$size", encoded.hex())
        }
        val rows = payloads.mapIndexed { index, bytes -> IrArrayWriter(listOf(bytes, payloads[(index + 1) % payloads.size]), !varInt).writeIntoMemory() }
        val encoded = IrArrayWriter(rows, varInt).writeIntoMemory()
        val reader = IrMultiArrayReader(encoded)
        check(reader.rowCount() == rows.size)
        for (row in rows.indices) {
            check(reader.tableItemBytes(row).contentEquals(rows[row]))
            check(reader.columnCount(row) == 2)
            check(reader.tableItemBytes(row, 0).contentEquals(payloads[row]))
            check(reader.tableItemBytes(row, 1).contentEquals(payloads[(row + 1) % payloads.size]))
        }
        record("multi-$varInt", encoded.hex())
    }
    val declarationData = listOf(SerializedDeclaration(-7, payloads[1]), SerializedDeclaration(Int.MAX_VALUE, payloads[2]),
        SerializedDeclaration(5, payloads[0]), SerializedDeclaration(Int.MIN_VALUE, payloads[3]))
    val declarationBytes = IrDeclarationWriter(declarationData).writeIntoMemory()
    val declarationReader = DeclarationIdTableReader(declarationBytes)
    check(declarationReader.entryCount() == declarationData.size)
    for (item in declarationData) check(declarationReader.tableItemBytes(DeclarationId(item.id)).contentEquals(item.bytes))
    record("declaration-ids", declarationBytes.hex())
    val duplicate = IrDeclarationWriter(listOf(SerializedDeclaration(5, payloads[1]), SerializedDeclaration(5, payloads[2]))).writeIntoMemory()
    val duplicateReader = DeclarationIdTableReader(duplicate)
    check(duplicateReader.entryCount() == 1 && duplicateReader.tableItemBytes(DeclarationId(5)).contentEquals(payloads[2]))
    record("duplicate-declaration-last-wins", duplicate.hex())
    val declarationRows = listOf(declarationBytes, duplicate, IrDeclarationWriter(emptyList()).writeIntoMemory())
    val declarationsMulti = DeclarationIdMultiTableReader(IrArrayWriter(declarationRows, true).writeIntoMemory())
    for (row in declarationRows.indices) check(declarationsMulti.tableItemBytes(row).contentEquals(declarationRows[row]))
    check(declarationsMulti.tableItemBytes(0, DeclarationId(Int.MIN_VALUE)).contentEquals(payloads[3]))
    record("declaration-multi", IrArrayWriter(declarationRows, true).writeIntoMemory().hex())
    val strings = listOf("", "Kotlin 한글", "\u0000\u007F\u0080\u07FF\u0800\uFFFF", "\uD83D\uDE00", "\uD800", "\uDFFF", "\uD800x\uDC00")
    for (value in strings) {
        val encoded = WobblyTF8.encode(value)
        check(WobblyTF8.decode(encoded) == value)
        record("wtf8-${value.codeUnits()}", encoded.hex())
    }
    for (bytes in listOf(byteArrayOf(-128), byteArrayOf(-62), byteArrayOf(-30, -126), byteArrayOf(-16, -97, -104),
        byteArrayOf(-32, -128, -128), byteArrayOf(-1), byteArrayOf(-11, -65, -65, -65))) {
        record("wtf8-invalid-${bytes.hex()}", WobblyTF8.decode(bytes).codeUnits())
    }
    for (varInt in listOf(false, true)) record("strings-$varInt", IrStringWriter(strings, varInt).writeIntoMemory().hex())
    return "{" + records.joinToString(",") + "}"
}

/** A bounded observation stream. This captures bytes, not a hash-based approximation of semantic equality. */
private class Snapshot {
    private val parts = mutableListOf<ByteArray>()
    private var size = 0
    fun bytes(bytes: ByteArray) {
        int(bytes.size)
        raw(bytes)
    }
    fun int(value: Int) { raw(byteArrayOf((value ushr 24).toByte(), (value ushr 16).toByte(), (value ushr 8).toByte(), value.toByte())) }
    fun text(value: String) { bytes(WobblyTF8.encode(value)) }
    private fun raw(bytes: ByteArray) {
        require(bytes.size <= 64 * 1024 * 1024 - size)
        size += bytes.size
        parts.add(bytes)
    }
    fun finish(): ByteArray {
        val output = ByteArray(size)
        var offset = 0
        for (part in parts) { part.copyInto(output, offset); offset += part.size }
        return output
    }
}

private fun ByteArray.bigEndianInt(offset: Int): Int {
    require(offset >= 0 && offset <= size - 4)
    return ((this[offset].toInt() and 255) shl 24) or ((this[offset + 1].toInt() and 255) shl 16) or
        ((this[offset + 2].toInt() and 255) shl 8) or (this[offset + 3].toInt() and 255)
}

fun librarySnapshot(
    manifest: Map<String, String>, versioning: KotlinLibraryVersioning, metadata: KlibMetadataComponent,
    main: KlibIrComponent?, inlinable: KlibIrComponent?, mainDebug: IrMultiArrayReader?, inlinableDebug: IrMultiArrayReader?,
): ByteArray {
    val snapshot = Snapshot()
    snapshot.int(manifest.size)
    for ([key, value] in manifest.toList().sortedBy { it.first }) { snapshot.text(key); snapshot.text(value) }
    snapshot.text(versioning.compilerVersion.orEmpty())
    snapshot.text(versioning.abiVersion?.toString().orEmpty())
    snapshot.text(versioning.metadataVersion?.toString().orEmpty())
    snapshot.text(versioning.irSignatureVersions.sortedBy { it.number }.joinToString(",") { it.number.toString() })
    snapshot.bytes(metadata.moduleHeaderData ?: error("Missing metadata header"))
    val packages = metadata.getPackageNames().sorted()
    snapshot.int(packages.size)
    for (packageName in packages) {
        snapshot.text(packageName)
        val fragments = metadata.getPackageFragmentNames(packageName).sorted()
        snapshot.int(fragments.size)
        for (fragment in fragments) { snapshot.text(fragment); snapshot.bytes(metadata.getPackageFragment(packageName, fragment)) }
    }
    fun ir(component: KlibIrComponent?, debugTable: IrMultiArrayReader?) {
        if (component == null) { snapshot.int(-1); return }
        snapshot.int(component.irFileCount)
        for (file in 0 until component.irFileCount) {
            snapshot.bytes(component.irFile(file))
            val declarations = component.declarations(file)
            snapshot.bytes(declarations)
            val count = declarations.bigEndianInt(0)
            require(count in 0..1000000 && count <= (declarations.size - 4) / 12)
            snapshot.int(count)
            for (index in 0 until count) {
                val id = declarations.bigEndianInt(4 + index * 12)
                snapshot.int(id)
                snapshot.bytes(component.declaration(id, file))
            }
            fun table(bytes: ByteArray?, item: (Int) -> ByteArray?) {
                if (bytes == null) { snapshot.int(-1); return }
                snapshot.bytes(bytes)
                val reader = IrArrayReader(bytes)
                snapshot.int(reader.entryCount())
                for (index in 0 until reader.entryCount()) snapshot.bytes(item(index) ?: error("Missing optional table item"))
            }
            table(component.irFileEntries(file)) { component.irFileEntry(it, file) }
            table(component.bodies(file)) { component.body(it, file) }
            table(component.types(file)) { component.type(it, file) }
            table(component.signatures(file)) { component.signature(it, file) }
            table(component.stringLiterals(file)) { component.stringLiteral(it, file) }
            // Debug-info has its own table indices; its count need not equal the signature count.
            if (debugTable == null) {
                snapshot.int(-1)
                check(component.signatureDebugInfo(0, file) == null)
            } else {
                val debugCount = debugTable.columnCount(file)
                snapshot.int(debugCount)
                for (index in 0 until debugCount) snapshot.bytes(component.signatureDebugInfo(index, file) ?: error("Missing debug item"))
            }
        }
    }
    ir(main, mainDebug)
    ir(inlinable, inlinableDebug)
    return snapshot.finish()
}

val manifestCorpus: List<String> = listOf("", "#comment\n!comment\r\n", "a=1\nb: 2\r\nc 3\rkeyOnly\n=empty-key",
    "a=first\na=last\n", "escaped\\ key\\:=\\ value\\=\\:\\#\\!", "unicode=\\uD83D\\uDE00\\uD800\\uDFFF",
    "newlines=\\t\\n\\r\\f\\q\\\\", "continued=first\\\n   second\\\r\n\tthird\n", "comment=literal\\\n #still value\n",
    "spaces\t:\t trimmed leading, preserved trailing  \n", "a=backslash\\\\\n", "last=trailing\\", "\\", "key=\\u00E4한글")

fun manifestSnapshot(parse: (String) -> Map<String, String>): String = manifestCorpus.mapIndexed { index, text ->
    val values = parse(text).toList().sortedBy { it.first }
    "\"$index\":\"" + values.joinToString(";") { it.first.codeUnits() + "=" + it.second.codeUnits() } + "\""
}.joinToString(",", "{", "}")
