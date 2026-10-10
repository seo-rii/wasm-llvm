package org.jetbrains.kotlin.portable.linkerprobe

import org.jetbrains.kotlin.library.readKonanLibraryVersioning
import org.jetbrains.kotlin.library.impl.KlibFileEntry
import org.jetbrains.kotlin.library.impl.VerifiedKlibFileSet
import org.jetbrains.kotlin.portable.klib.ManifestProperties
import org.jetbrains.kotlin.portable.klib.klibSha256
import org.jetbrains.kotlin.portable.linker.*
import org.jetbrains.kotlin.portable.source.LibraryPath

fun fixtureFileSet(files: Map<String, ByteArray>) = VerifiedKlibFileSet.verify(files.map { [path, bytes] -> KlibFileEntry(path, bytes, klibSha256(bytes)) })

fun portableWriterSnapshot(files: Map<String, ByteArray>): ByteArray {
    val manifest = ManifestProperties.fromUtf8(files.getValue("default/manifest"))
    val library = fixtureWriter(files, manifest.readKonanLibraryVersioning(), manifest.asMap()).writeIntoMemory(LibraryPath("/writer-result"))
    val output = library.requireMemoryKlibFiles()
    return outputSnapshot(output.filePaths.associateWith(output::read), output.directoryPaths.toList())
}
