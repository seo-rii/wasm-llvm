package org.jetbrains.kotlin.portable.klibprobe

import org.jetbrains.kotlin.library.impl.*
import org.jetbrains.kotlin.portable.klib.*
import org.jetbrains.kotlin.portable.source.LibraryPath

fun portableChecks(): String {
    val passed = mutableListOf<String>()
    fun rejected(name: String, block: () -> Unit) {
        var error = false
        try { block() } catch (_: Throwable) { error = true }
        check(error) { "Expected rejection: $name" }
        passed.add(name)
    }
    fun ints(vararg values: Int): ByteArray = PortableDataOutput().also { out -> values.forEach(out::writeInt) }.toByteArray()
    rejected("truncated-count") { IrArrayReader(byteArrayOf(0, 0, 0)) }
    rejected("min-count-overflow") { IrArrayReader(ints(Int.MIN_VALUE)) }
    rejected("excessive-count") { IrArrayReader(ints(Int.MAX_VALUE)) }
    rejected("negative-element-size") { IrArrayReader(ints(1, -1)) }
    rejected("payload-truncation") { IrArrayReader(ints(1, 100)) }
    rejected("unsigned-size-overflow") { IrArrayReader(ints(-1) + byteArrayOf(-1, -1, -1, -1, 15)) }
    rejected("leb32-payload-overflow") { IrArrayReader(ints(-1) + byteArrayOf(-128, -128, -128, -128, 16)) }
    rejected("leb32-continuation-overflow") { IrArrayReader(ints(-1) + byteArrayOf(-128, -128, -128, -128, -128, 0)) }
    rejected("nested-row-header-truncation") { IrMultiArrayReader(ints(1, 4, 1) + ints(0)).columnCount(0) }
    rejected("nested-payload-crosses-row") { IrMultiArrayReader(ints(2, 8, 4, 1, 4, 0)).columnCount(0) }
    rejected("negative-declaration-count") { DeclarationIdTableReader(ints(-1)) }
    rejected("declaration-header-overlap") { DeclarationIdTableReader(ints(1, 7, 4, 0)) }
    rejected("declaration-range-overflow") { DeclarationIdTableReader(ints(1, 7, Int.MAX_VALUE, 1)) }
    rejected("nested-declaration-crosses-row") {
        DeclarationIdMultiTableReader(ints(2, 16, 4, 1, 7, 16, 4, 0)).tableItemBytes(0, DeclarationId(7))
    }
    val output = PortableDataOutput(4)
    output.writeInt(Int.MIN_VALUE)
    rejected("output-limit") { output.write(1) }
    rejected("failed-output-not-returned") { output.toByteArray() }
    rejected("failed-output-not-reused") { output.write(0) }
    rejected("malformed-manifest-unicode") { ManifestProperties.fromText("a=\\u12xz") }
    val frozen = ManifestProperties.fromText("a=1").freeze()
    rejected("manifest-immutable") { frozen.setProperty("a", "2") }
    val provider = ReadByteBufferProvider.MemoryBuffer(ints(3))
    rejected("reentrant-reader") { provider.use { provider.use { } } }
    check(provider.use { it.int } == 3)
    passed.add("reader-recovery-after-reentrancy")
    check(klibSha256(byteArrayOf()) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    check(klibSha256("abc".encodeToByteArray()) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    passed.add("sha256-independent-vectors")
    fun entry(path: String, bytes: ByteArray = byteArrayOf()) = KlibFileEntry(path, bytes, klibSha256(bytes))
    rejected("library-path-traversal") { VerifiedKlibFileSet.verify(listOf(entry("../file"))) }
    rejected("library-absolute-path") { VerifiedKlibFileSet.verify(listOf(entry("/file"))) }
    rejected("library-duplicate-path") { VerifiedKlibFileSet.verify(listOf(entry("file"), entry("file"))) }
    rejected("library-file-shadows-directory") { VerifiedKlibFileSet.verify(listOf(entry("file"), entry("file/child"))) }
    rejected("library-hash-mismatch") { VerifiedKlibFileSet.verify(listOf(KlibFileEntry("file", byteArrayOf(1), klibSha256(byteArrayOf())))) }
    val sourceBytes = byteArrayOf(1, 2, 3)
    val immutable = VerifiedKlibFileSet.verify(listOf(entry("file", sourceBytes)))
    sourceBytes[0] = 9
    val returned = immutable.read("file")
    returned[1] = 9
    check(immutable.read("file").contentEquals(byteArrayOf(1, 2, 3)))
    passed.add("verified-files-immutable-ownership")
    val manifest = entry("default/manifest", "unique_name=unit\nabi_version=2.5.0\nmetadata_version=2.5.0\nir_signature_versions=1,2\n".encodeToByteArray())
    rejected("library-missing-metadata") { MemoryKotlinLibrary(LibraryPath("/unit"), VerifiedKlibFileSet.verify(listOf(manifest))) }
    rejected("library-partial-ir") {
        MemoryKotlinLibrary(LibraryPath("/unit"), VerifiedKlibFileSet.verify(listOf(manifest, entry("default/linkdata/module"), entry("default/ir/files.knf", ints(0)))))
    }
    return passed.joinToString(",", "[", "]") { "\"$it\"" }
}
