package org.jetbrains.kotlin.protobuf.probe

import java.nio.file.Files
import java.nio.file.Path
import org.jetbrains.kotlin.protobuf.InvalidProtocolBufferException
import org.jetbrains.kotlin.protobuf.UninitializedMessageException

fun main(args: Array<String>) {
    check(verifyGeneratedApi())
    val manifest = Path.of(args[0]); val base = manifest.parent
    for (line in Files.readAllLines(manifest)) {
        if (line.isEmpty()) continue
        val parts = line.split('\t')
        val bytes = Files.readAllBytes(base.resolve(parts[2]))
        try {
            val result = decodeForProbe(parts[1], bytes, parts[3].toBooleanStrict(), parts[4].toBooleanStrict(), parts[5].toInt())
            println(parts[0] + "\tok\t" + result.joinToString("") { (it.toInt() and 255).toString(16).padStart(2,'0') })
        } catch (_: UninitializedMessageException) { println(parts[0] + "\terror\tUninitializedMessageException") } catch (_: InvalidProtocolBufferException) { println(parts[0] + "\terror\tInvalidProtocolBufferException") }
    }
}
