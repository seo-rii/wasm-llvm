package org.jetbrains.kotlin.kmp.probe

// Filesystem access belongs to this build-time JVM observation adapter only.
fun main(arguments: Array<String>) {
    print(arguments.joinToString(prefix = "[", postfix = "]", separator = ",") { path ->
        snapshot(java.io.File(path).readText(Charsets.UTF_8))
    })
}
