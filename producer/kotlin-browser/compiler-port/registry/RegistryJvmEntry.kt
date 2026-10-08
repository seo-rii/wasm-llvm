package org.jetbrains.kotlin.portable.registryprobe

fun main() {
    val first = registryProbe()
    check(registryProbe() == first) { "Registry lifetime changed the second observation" }
    println(first)
}
