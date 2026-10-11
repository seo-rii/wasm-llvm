package org.jetbrains.kotlin.backend.common.indexprobe

import org.jetbrains.kotlin.backend.common.KlibSignatureIndexComponent
import org.jetbrains.kotlin.backend.common.KlibSignatureIndexComponentWriterImpl
import org.jetbrains.kotlin.backend.common.serialization.proto.CommonIdSignature
import org.jetbrains.kotlin.ir.util.IdSignature
import org.jetbrains.kotlin.ir.util.IdSignatureRenderer
import org.jetbrains.kotlin.ir.util.render
import org.jetbrains.kotlin.library.SerializedSignatureIndex
import org.jetbrains.kotlin.library.impl.IrArrayWriter
import org.jetbrains.kotlin.library.impl.IrStringWriter
import org.jetbrains.kotlin.name.FqName

private fun ByteArray.hex(): String = joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }
private fun utf16(value: String): String = value.map { it.code.toString(16).padStart(4, '0') }.joinToString("")
private fun signatures(values: Set<IdSignature>): String = values.map { utf16(it.render(IdSignatureRenderer.LEGACY)) }.sorted().joinToString(",")
private fun c(pkg: String, name: String, id: Long? = null, mask: Long = 0, description: String? = null) =
    IdSignature.CommonSignature(pkg, name, id, mask, description)

fun observeSignatureIndex(
    read: (ByteArray?) -> KlibSignatureIndexComponent?,
    write: (SerializedSignatureIndex) -> ByteArray,
    typeName: (IdSignature) -> String,
): String {
    val rows = mutableListOf<String>()
    fun roundtrip(name: String, exported: Set<IdSignature>, imported: Set<IdSignature>) {
        val serialized = KlibSignatureIndexComponentWriterImpl(exported, imported).serializedSignatureIndex
        check(write(serialized).contentEquals(serialized.signatureIndex))
        val component = checkNotNull(read(serialized.signatureIndex))
        rows += "$name:${serialized.signatureIndex.hex()}:${signatures(component.exportedTopLevelSignatures)}:${signatures(component.importedTopLevelSignatures)}"
        check(component.exportedTopLevelSignatures === component.exportedTopLevelSignatures)
        check(component.importedTopLevelSignatures === component.importedTopLevelSignatures)
    }
    rows += "absent:${read(null) == null}"
    roundtrip("empty", emptySet(), emptySet())
    roundtrip("export", setOf(c("p", "A"), c("p", "B", Long.MIN_VALUE, 15), c("", "", null)), emptySet())
    roundtrip("import", emptySet(), setOf(c("q.x", "C.f", Long.MAX_VALUE, -1)))
    val values = listOf(c("z", "Z", 3), c("a", "A", 1), c("b", "B", 2))
    roundtrip("ordered", values.toSet(), values.asReversed().toSet())
    roundtrip("reversed", values.asReversed().toSet(), values.toSet())
    roundtrip("description-sort", setOf(c("p", "A", 11, 1, "z"), c("p", "A", 12, 1, "a")), emptySet())
    roundtrip("wobbly", setOf(c("한글.😀.\uD800", "A.\uDC00", 123, 2)), setOf(c("", "Empty", 0)))

    fun table(strings: List<String>, exports: List<ByteArray>, imports: List<ByteArray>, extra: Boolean = false): ByteArray =
        IrArrayWriter(listOf(
            IrStringWriter(strings, true).writeIntoMemory(),
            IrArrayWriter(exports, true).writeIntoMemory(), IrArrayWriter(imports, true).writeIntoMemory(),
        ) + if (extra) listOf(byteArrayOf(0)) else emptyList(), true).writeIntoMemory()
    fun proto(id: Long?, old: Long?, flags: Long): ByteArray = CommonIdSignature.newBuilder().apply {
        addPackageFqName(0); addDeclarationFqName(1)
        id?.let { setMemberUniqId(it) }; old?.let { setMemberUniqIdPre240(it) }; setFlags(flags)
    }.build().toByteArray()
    for ([name, bytes] in listOf(
        "id-current" to proto(13, null, 5), "id-legacy" to proto(null, -9, 7),
        "id-both" to proto(17, 19, 8), "id-absent" to proto(null, null, 0),
    )) {
        val component = checkNotNull(read(table(listOf("p", "D"), listOf(bytes, bytes), emptyList())))
        rows += "$name:${signatures(component.exportedTopLevelSignatures)}:${component.exportedTopLevelSignatures.size}"
    }
    rows += "extra-row:" + signatures(read(table(listOf("p", "D"), listOf(proto(2, null, 0)), emptyList(), true))!!.exportedTopLevelSignatures)
    for (count in 0..2) {
        val bytes = IrArrayWriter(List(count) { byteArrayOf() }, true).writeIntoMemory()
        val component = checkNotNull(read(bytes)) // Availability does not eagerly decode.
        val error = runCatching { component.exportedTopLevelSignatures }.exceptionOrNull()
        check(error is IllegalStateException)
        rows += "rows-$count:${error.message}"
    }
    for ([name, bytes] in listOf(
        "bad-protobuf" to table(listOf("p", "D"), listOf(byteArrayOf(0)), emptyList()),
        "bad-string-index" to table(emptyList(), listOf(proto(1, null, 0)), emptyList()),
        "truncated-table" to byteArrayOf(3),
    )) {
        val component = checkNotNull(read(bytes))
        check(runCatching { component.exportedTopLevelSignatures }.isFailure)
        rows += "$name:rejected" // Existing portable byte limits deliberately change malformed-input exception details.
    }

    val common = c("p", "C", 1)
    val allTypes: List<IdSignature> = listOf(
        common, IdSignature.CompositeSignature(common, common), IdSignature.AccessorSignature(common, common),
        IdSignature.FileSignature(Any(), FqName("p"), "file.kt"), IdSignature.LocalSignature("local", 2),
        IdSignature.SpecialFakeOverrideSignature(common, listOf(common)), IdSignature.FileLocalSignature(common, 3),
        IdSignature.ScopeLocalDeclaration(4), IdSignature.LoweredDeclarationSignature(common, 5, 6),
    )
    // The valid subtype also exercises the only accepted serialization branch; every other type must fail with its exact JVM binary name.
    for (signature in allTypes) {
        rows += "binary-type:" + typeName(signature)
        val error = runCatching { KlibSignatureIndexComponentWriterImpl(setOf(signature), emptySet()) }.exceptionOrNull()
        rows += "type:${utf16(error?.message ?: "CommonSignature:accepted")}"
        check((error == null) == (signature is IdSignature.CommonSignature))
    }
    return rows.joinToString("\n", postfix = "\n")
}
