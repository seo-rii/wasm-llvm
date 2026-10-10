package org.jetbrains.kotlin.portable.klibprobe

import org.jetbrains.kotlin.library.components.*
import org.jetbrains.kotlin.library.impl.*
import org.jetbrains.kotlin.portable.klib.ManifestProperties
import org.jetbrains.kotlin.portable.source.LibraryPath
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import kotlin.io.path.readBytes
import kotlin.io.path.writeBytes

fun main(args: Array<String>) {
    val root = Path.of(args[0])
    fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }
    val entries = Files.walk(root).use { stream -> stream.filter { Files.isRegularFile(it) }.toList() }.map { path ->
        val bytes = path.readBytes()
        KlibFileEntry(root.relativize(path).toString().replace('\\', '/'), bytes, digest(bytes))
    }
    val directories = Files.walk(root).use { stream -> stream.filter { Files.isDirectory(it) }.toList() }.filter { it != root }.map { root.relativize(it).toString().replace('\\', '/') }
    val verified = VerifiedKlibFileSet.verify(entries, directories)
    val library = MemoryKotlinLibrary(LibraryPath("/stdlib"), verified)
    Path.of(args[1]).writeBytes(librarySnapshot(library.manifestProperties.asMap(), library.versions, library.metadata, library.ir, library.inlinableFunctionsIr,
        IrMultiArrayReader(verified.read("default/ir/debugInfo.knd")), IrMultiArrayReader(verified.read("default/ir_inlinable_functions/debugInfo.knd"))))
    println(unitSnapshot())
    println(manifestSnapshot { ManifestProperties.fromText(it).asMap() })
    println(portableChecks())
}
