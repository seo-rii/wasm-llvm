package org.jetbrains.kotlin.portable.linker

import org.jetbrains.kotlin.library.KotlinLibrary
import org.jetbrains.kotlin.library.klibAttribute
import org.jetbrains.kotlin.library.impl.VerifiedKlibFileSet

/** Data is tied to a verified library instance; no global mutable library cache is introduced. */
private var KotlinLibrary.memoryFiles: VerifiedKlibFileSet? by klibAttribute()

fun KotlinLibrary.attachMemoryKlibFiles(files: VerifiedKlibFileSet) {
    check(memoryFiles == null) { "A memory library file index can only be attached once" }
    memoryFiles = files
}

fun KotlinLibrary.requireMemoryKlibFiles(): VerifiedKlibFileSet =
    checkNotNull(memoryFiles) { "Library has no verified memory file index" }

fun KotlinLibrary.memoryJarImplementationVersion(): String? {
    val files = requireMemoryKlibFiles()
    val path = "META-INF/MANIFEST.MF"
    return if (files.contains(path)) jarImplementationVersion(files.read(path)) else null
}

/**
 * Reads the JAR main-section attribute used by the official special compatibility checker.
 * Continuations are joined as bytes before UTF-8 decoding, including split multibyte sequences.
 * All sections are validated. The finite manifest/line bounds are explicit host policy.
 */
fun jarImplementationVersion(bytes: ByteArray): String? {
    require(bytes.size <= 1024 * 1024) { "JAR manifest exceeds the byte limit" }
    var cursor = 0
    var section = 0
    var previousName: String? = null
    var previousValue = mutableListOf<Byte>()
    var implementationVersion: String? = null
    var headers = 0
    var sectionStart = true

    fun finishHeader() {
        val name = previousName ?: return
        if (section == 0 && name.equals("Implementation-Version", ignoreCase = true)) {
            implementationVersion = previousValue.toByteArray().decodeToString()
        }
        previousName = null
        previousValue.clear()
    }

    while (cursor < bytes.size) {
        val start = cursor
        while (cursor < bytes.size && bytes[cursor] != 10.toByte() && bytes[cursor] != 13.toByte()) cursor++
        // The JDK reader ignores an unterminated physical line. If it is a continuation,
        // the pending header is incomplete and must not be committed either.
        if (cursor == bytes.size) {
            if (bytes[start] == 32.toByte()) previousName = null
            break
        }
        var end = cursor++
        if (bytes[end] == 13.toByte() && cursor < bytes.size && bytes[cursor] == 10.toByte()) cursor++
        require(end - start <= 65536) { "JAR manifest line exceeds the byte limit" }
        if (end == start) {
            finishHeader()
            section++
            sectionStart = true
            continue
        }
        if (bytes[start] == 32.toByte()) {
            require(previousName != null) { "JAR manifest continuation has no header" }
            for (index in start + 1 until end) previousValue.add(bytes[index])
            continue
        }
        finishHeader()
        var colon = start
        while (colon < end && bytes[colon] != 58.toByte()) colon++
        require(colon in start + 1 until end - 1 && bytes[colon + 1] == 32.toByte()) { "Invalid JAR manifest header" }
        require(colon - start <= 70) { "Invalid JAR manifest attribute name" }
        val name = bytes.copyOfRange(start, colon).decodeToString()
        require(name.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '-' || it == '_' }) { "Invalid JAR manifest attribute name" }
        require(section == 0 || !sectionStart || name.equals("Name", ignoreCase = true)) { "JAR manifest section has no Name header" }
        sectionStart = false
        require(++headers <= 16384) { "Too many JAR manifest attributes" }
        previousName = name
        for (index in colon + 2 until end) previousValue.add(bytes[index])
    }
    finishHeader()
    return implementationVersion
}
