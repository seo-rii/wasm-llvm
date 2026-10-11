package org.jetbrains.kotlin.backend.common.indexprobe

import org.jetbrains.kotlin.backend.common.*
import org.jetbrains.kotlin.library.impl.KlibFileEntry
import org.jetbrains.kotlin.library.impl.MemoryKotlinLibrary
import org.jetbrains.kotlin.library.impl.VerifiedKlibFileSet
import org.jetbrains.kotlin.library.writer.MemoryKlibOutput
import org.jetbrains.kotlin.portable.klib.klibSha256
import org.jetbrains.kotlin.portable.source.LibraryPath

fun portableIndexObservations(): String = observeSignatureIndex(
    typeName = ::signatureIndexTypeName,
    read = { bytes ->
        val entries = linkedMapOf(
            "default/manifest" to "unique_name=index-probe\n".encodeToByteArray(),
            "default/linkdata/module" to byteArrayOf(),
        )
        if (bytes != null) entries["default/indices/signatures.idx"] = bytes
        val files = VerifiedKlibFileSet.verify(entries.map { [name, data] -> KlibFileEntry(name, data, klibSha256(data)) })
        val library = MemoryKotlinLibrary(LibraryPath("/index.klib"), files)
        val component = library.getComponent(KlibSignatureIndexComponent.Kind)
        check(component === library.getComponent(KlibSignatureIndexComponent.Kind))
        check(component === library.signatureIndex)
        component
    },
    write = { bytes ->
        val output = MemoryKlibOutput(LibraryPath("/output"))
        output.writeBytes(LibraryPath("/output/default/manifest"), "unique_name=writer-probe\n".encodeToByteArray())
        output.writeBytes(LibraryPath("/output/default/linkdata/module"), byteArrayOf())
        KlibSignatureIndexComponentWriterImpl(bytes).writeTo(output)
        val library = output.finish()
        check(library.getComponent(KlibSignatureIndexComponent.Kind) != null)
        output.completedEntries().single { it.path == "default/indices/signatures.idx" }.bytes
    },
)
