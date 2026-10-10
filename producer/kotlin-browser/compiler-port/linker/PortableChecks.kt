package org.jetbrains.kotlin.portable.linkerprobe

import org.jetbrains.kotlin.library.impl.*
import org.jetbrains.kotlin.library.loader.KlibPlatformChecker
import org.jetbrains.kotlin.library.writer.MemoryKlibOutput
import org.jetbrains.kotlin.library.writer.MemoryKlibOutputLimits
import org.jetbrains.kotlin.portable.klib.ManifestProperties
import org.jetbrains.kotlin.portable.klib.klibSha256
import org.jetbrains.kotlin.portable.linker.*
import org.jetbrains.kotlin.portable.source.LibraryPath

fun portableChecks(files: Map<String, ByteArray>): String {
    val passed = mutableListOf<String>()
    fun failure(name: String, action: () -> Unit) {
        var failed = false
        try { action() } catch (_: Exception) { failed = true }
        check(failed) { "Expected failure did not occur: $name" }
        passed.add(name)
    }
    fun output() = MemoryKlibOutput(LibraryPath("/result"))
    failure("relative-output-root") { MemoryKlibOutput(LibraryPath("relative")) }
    failure("output-root-escape") { output().writeBytes(LibraryPath("/result2/file"), byteArrayOf()) }
    failure("root-as-file") { output().writeBytes(LibraryPath("/result"), byteArrayOf()) }
    failure("duplicate-output") { val output = output(); output.writeBytes(LibraryPath("/result/file"), byteArrayOf()); output.writeBytes(LibraryPath("/result/file"), byteArrayOf()) }
    failure("file-shadows-directory") { val output = output(); output.createDirectories(LibraryPath("/result/dir")); output.writeBytes(LibraryPath("/result/dir"), byteArrayOf()) }
    failure("directory-shadows-file") { val output = output(); output.writeBytes(LibraryPath("/result/file"), byteArrayOf()); output.createDirectories(LibraryPath("/result/file")) }
    failure("failed-output-closed") { val output = output(); try { output.writeBytes(LibraryPath("/other/file"), byteArrayOf()) } catch (_: Exception) {}; output.writeBytes(LibraryPath("/result/file"), byteArrayOf()) }
    failure("incomplete-no-entries") { output().completedEntries() }
    failure("incomplete-no-library") { output().finish() }
    failure("malformed-properties-high") { output().writeProperties(LibraryPath("/result/p"), ManifestProperties().apply { setProperty("key", "\uD800") }) }
    failure("malformed-properties-low") { output().writeProperties(LibraryPath("/result/p"), ManifestProperties().apply { setProperty("key", "\uDC00") }) }
    failure("malformed-properties-poison") { val output = output(); try { output.writeProperties(LibraryPath("/result/p"), ManifestProperties().apply { setProperty("key", "\uD800") }) } catch (_: Exception) {}; output.completedEntries() }
    failure("invalid-negative-limit") { MemoryKlibOutputLimits(files = -1) }
    failure("invalid-raised-limit") { MemoryKlibOutputLimits(decodedBytes = VerifiedKlibFileSet.MAX_DECODED_BYTES + 1) }
    failure("file-byte-limit") { MemoryKlibOutput(LibraryPath("/result"), MemoryKlibOutputLimits(fileBytes = 4)).writeBytes(LibraryPath("/result/file"), ByteArray(5)) }
    failure("aggregate-byte-limit") {
        val output = MemoryKlibOutput(LibraryPath("/result"), MemoryKlibOutputLimits(fileBytes = 4, decodedBytes = 7))
        output.writeBytes(LibraryPath("/result/a"), ByteArray(4)); output.writeBytes(LibraryPath("/result/b"), ByteArray(4))
    }
    failure("file-count-limit") {
        val output = MemoryKlibOutput(LibraryPath("/result"), MemoryKlibOutputLimits(files = 1))
        output.writeBytes(LibraryPath("/result/a"), byteArrayOf()); output.writeBytes(LibraryPath("/result/b"), byteArrayOf())
    }
    failure("directory-count-limit") { MemoryKlibOutput(LibraryPath("/result"), MemoryKlibOutputLimits(directories = 2)).createDirectories(LibraryPath("/result/a/b/c")) }
    failure("limit-failure-poisons-output") {
        val output = MemoryKlibOutput(LibraryPath("/result"), MemoryKlibOutputLimits(fileBytes = 1))
        try { output.writeBytes(LibraryPath("/result/a"), byteArrayOf(1, 2)) } catch (_: Exception) {}
        output.writeBytes(LibraryPath("/result/b"), byteArrayOf(1))
    }
    val verified = fixtureFileSet(files)
    val input = MemoryKlibInput(LibraryPath("/stdlib"), verified)
    val loaded = loadMemoryKlibs(listOf(input), KlibPlatformChecker.Wasm("wasm-wasi"))
    check(!loaded.hasProblems && loaded.librariesStdlibFirst.single().path == input.path)
    passed.add("actual-stdlib-platform-abi")
    check(loadMemoryKlibs(listOf(input), KlibPlatformChecker.Wasm("wasm-js")).hasProblems)
    passed.add("wrong-target-rejected")
    check(loadMemoryKlibs(listOf(input), KlibPlatformChecker.JS).hasProblems)
    passed.add("wrong-platform-rejected")
    failure("duplicate-library-path") { loadMemoryKlibs(listOf(input, input), KlibPlatformChecker.Wasm("wasm-wasi")) }
    failure("missing-include-path") { loaded.selectMemoryLibrariesByPaths(listOf(LibraryPath("/missing"))) }
    check(loaded.selectMemoryLibrariesByPaths(listOf(LibraryPath("/stdlib"), LibraryPath("/stdlib"))).size == 1)
    passed.add("canonical-library-lookup")
    val invalidAbi = files.toMutableMap().apply {
        val manifest = ManifestProperties.fromUtf8(getValue("default/manifest"))
        manifest.setProperty("abi_version", "999.0.0")
        put("default/manifest", manifest.asMap().map { (key, value) -> "$key=$value" }.joinToString("\n").encodeToByteArray())
    }
    val invalid = MemoryKlibInput(LibraryPath("/wrong-abi"), fixtureFileSet(invalidAbi))
    check(loadMemoryKlibs(listOf(invalid), KlibPlatformChecker.Wasm("wasm-wasi")).hasProblems)
    passed.add("wrong-abi-rejected")
    failure("unattached-library-check") { MemoryKotlinLibrary(LibraryPath("/stdlib"), verified).memoryJarImplementationVersion() }
    failure("file-index-double-attach") { val library = input.createLibrary(); library.attachMemoryKlibFiles(verified) }
    check(input.createLibrary().memoryJarImplementationVersion() == null)
    passed.add("absent-jar-manifest")
    val jarFile = "Implementation-Version: 2.5.0\n\n".encodeToByteArray()
    val withJar = files.toMutableMap().apply { put("META-INF/MANIFEST.MF", jarFile) }
    check(MemoryKlibInput(LibraryPath("/with-jar"), fixtureFileSet(withJar)).createLibrary().memoryJarImplementationVersion() == "2.5.0")
    passed.add("real-jar-version-present")
    return passed.joinToString("\n")
}
