package org.jetbrains.kotlin.backend.common.indexprobe

import org.jetbrains.kotlin.backend.common.*
import org.jetbrains.kotlin.library.KlibLayoutReader
import org.jetbrains.kotlin.library.SerializedSignatureIndex
import java.nio.file.Files
import kotlin.io.path.createDirectories
import kotlin.io.path.readBytes
import kotlin.io.path.writeBytes

fun main() {
    val roots = mutableListOf<java.nio.file.Path>()
    try {
        print(observeSignatureIndex(
            typeName = { it.javaClass.name },
            read = { bytes ->
                val root = Files.createTempDirectory("signature-index-reference-").also { roots.add(it) }
                if (bytes != null) {
                    val target = KlibSignatureIndexComponentLayout(root).signatureIndexFile
                    target.parent.createDirectories(); target.writeBytes(bytes)
                }
                KlibSignatureIndexComponent.Kind.createComponentIfDataInKlibIsAvailable(KlibLayoutReader.FromDirectory(root, ::KlibSignatureIndexComponentLayout))
            },
            write = { bytes: SerializedSignatureIndex ->
                val root = Files.createTempDirectory("signature-index-writer-").also { roots.add(it) }
                KlibSignatureIndexComponentWriterImpl(bytes).writeTo(root)
                KlibSignatureIndexComponentLayout(root).signatureIndexFile.readBytes()
            },
        ))
    } finally { for (root in roots) Files.walk(root).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach(Files::delete) } }
}
