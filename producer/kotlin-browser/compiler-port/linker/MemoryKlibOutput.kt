package org.jetbrains.kotlin.library.writer

import org.jetbrains.kotlin.library.impl.KlibFileEntry
import org.jetbrains.kotlin.library.impl.MemoryKotlinLibrary
import org.jetbrains.kotlin.library.impl.VerifiedKlibFileSet
import org.jetbrains.kotlin.portable.klib.KlibByteLimits
import org.jetbrains.kotlin.portable.klib.ManifestProperties
import org.jetbrains.kotlin.portable.klib.klibSha256
import org.jetbrains.kotlin.portable.linker.attachMemoryKlibFiles
import org.jetbrains.kotlin.portable.source.LibraryPath

/** Request-local logical output directory. A failed writer has no library result and must be discarded. */
class MemoryKlibOutput(
    val root: LibraryPath,
    private val limits: MemoryKlibOutputLimits = MemoryKlibOutputLimits(),
) {
    private val entries = linkedMapOf<String, ByteArray>()
    private val directories = linkedSetOf<String>()
    private var totalBytes = 0L
    private var finished = false
    private var failed = false

    init { require(root.isAbsolute) { "KLIB output root must be an absolute virtual path" } }

    private fun relative(path: LibraryPath): String {
        require(path.startsWith(root)) { "KLIB output escaped its virtual root" }
        return if (root.value == "/") path.value.removePrefix("/") else path.value.removePrefix(root.value).removePrefix("/")
    }

    private fun checkOpen() { check(!finished && !failed) { "KLIB output is closed or failed" } }

    fun createDirectories(path: LibraryPath) {
        checkOpen()
        try {
            var relative = relative(path)
            while (relative.isNotEmpty()) {
                require(relative !in entries) { "KLIB file shadows output directory" }
                directories.add(relative)
                require(directories.size <= limits.directories) { "Too many KLIB output directories" }
                relative = relative.substringBeforeLast('/', "")
            }
        } catch (error: Throwable) { failed = true; throw error }
    }

    fun writeBytes(path: LibraryPath, bytes: ByteArray) {
        checkOpen()
        try {
            val relative = relative(path)
            require(relative.isNotEmpty() && relative !in entries && relative !in directories) { "Duplicate or invalid KLIB output file" }
            require(entries.size < limits.files && bytes.size <= limits.fileBytes) { "KLIB output file limit exceeded" }
            val nextBytes = totalBytes + bytes.size
            require(nextBytes <= limits.decodedBytes) { "KLIB output byte limit exceeded" }
            createDirectories(LibraryPath(path.value.substringBeforeLast('/').ifEmpty { "/" }))
            entries[relative] = bytes.copyOf()
            totalBytes = nextBytes
        } catch (error: Throwable) { failed = true; throw error }
    }

    /** Sorted UTF-8 Java-properties text, matching the selected filesystem writer under the fixed ROOT locale. */
    fun writeProperties(path: LibraryPath, properties: ManifestProperties) {
        checkOpen()
        try {
            fun escape(value: String, key: Boolean): String = buildString {
                value.forEachIndexed { index, character ->
                    when (character) {
                        ' ' -> { if (key || index == 0) append('\\'); append(' ') }
                        '\\' -> append("\\\\")
                        '\t' -> append("\\t")
                        '\n' -> append("\\n")
                        '\r' -> append("\\r")
                        '\u000C' -> append("\\f")
                        '=', ':', '#', '!' -> { append('\\'); append(character) }
                        else -> append(character)
                    }
                }
            }
            val text = properties.asMap().map { (key, value) -> escape(key, true) + "=" + escape(value, false) }
                .sorted().joinToString("\n", postfix = "\n")
            // Files.newBufferedWriter(UTF_8) in the selected JVM writer reports malformed UTF-16.
            var index = 0
            while (index < text.length) {
                val character = text[index++]
                if (character.isHighSurrogate()) {
                    require(index < text.length && text[index++].isLowSurrogate()) { "Malformed UTF-16 manifest text" }
                } else require(!character.isLowSurrogate()) { "Malformed UTF-16 manifest text" }
            }
            writeBytes(path, text.encodeToByteArray())
        } catch (error: Throwable) { failed = true; throw error }
    }

    fun finish(): MemoryKotlinLibrary {
        checkOpen()
        try {
            val files = VerifiedKlibFileSet.verify(entries.map { [path, bytes] -> KlibFileEntry(path, bytes, klibSha256(bytes)) }, directories.toList())
            val library = MemoryKotlinLibrary(root, files)
            library.attachMemoryKlibFiles(files)
            finished = true
            return library
        } catch (error: Throwable) { failed = true; throw error }
    }

    /** Host packaging is allowed after a complete write. Paths/bytes are copied and remain bounded. */
    fun completedEntries(): List<KlibFileEntry> {
        check(finished && !failed) { "Incomplete KLIB output has no entries" }
        return entries.map { [path, bytes] -> KlibFileEntry(path, bytes.copyOf(), klibSha256(bytes)) }
    }
}

/** An approved compiler profile may tighten these limits, never exceed the common library hard limits. */
class MemoryKlibOutputLimits(
    val files: Int = VerifiedKlibFileSet.MAX_FILES,
    val directories: Int = VerifiedKlibFileSet.MAX_FILES,
    val fileBytes: Int = KlibByteLimits.MAX_BUFFER_BYTES,
    val decodedBytes: Long = VerifiedKlibFileSet.MAX_DECODED_BYTES,
) {
    init {
        require(files in 0..VerifiedKlibFileSet.MAX_FILES && directories in 0..VerifiedKlibFileSet.MAX_FILES)
        require(fileBytes in 0..KlibByteLimits.MAX_BUFFER_BYTES && decodedBytes in 0..VerifiedKlibFileSet.MAX_DECODED_BYTES)
    }
}
