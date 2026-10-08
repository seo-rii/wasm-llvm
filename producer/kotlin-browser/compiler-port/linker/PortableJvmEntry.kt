package org.jetbrains.kotlin.portable.linkerprobe

import org.jetbrains.kotlin.portable.linker.jarImplementationVersion
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.readBytes
import kotlin.io.path.writeBytes

fun main(args: Array<String>) {
    val root = Path.of(args[0])
    val files = Files.walk(root).use { paths -> paths.filter(Files::isRegularFile).toList() }.associate { path ->
        root.relativize(path).toString().replace('\\', '/') to path.readBytes()
    }
    Path.of(args[1]).writeBytes(portableWriterSnapshot(files))
    Path.of(args[2]).writeBytes(jarObservation(::jarImplementationVersion).encodeToByteArray())
    Path.of(args[3]).writeBytes(portableChecks(files).encodeToByteArray())
    println("writer-files=" + files.size + ",jar-cases=" + jarManifestCases().size)
}
