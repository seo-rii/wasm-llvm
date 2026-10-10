package org.jetbrains.kotlin.portable.linker

import org.jetbrains.kotlin.library.*
import org.jetbrains.kotlin.library.impl.MemoryKotlinLibrary
import org.jetbrains.kotlin.library.impl.VerifiedKlibFileSet
import org.jetbrains.kotlin.library.loader.KlibLoaderResult
import org.jetbrains.kotlin.library.loader.KlibLoaderResult.ProblemCase.IncompatibleAbiVersion
import org.jetbrains.kotlin.library.loader.KlibLoaderResult.ProblematicLibrary
import org.jetbrains.kotlin.library.loader.KlibPlatformChecker
import org.jetbrains.kotlin.portable.source.LibraryPath

/** The caller supplies only the approved, independently hash-verified library file sets. */
class MemoryKlibInput(val path: LibraryPath, val files: VerifiedKlibFileSet) {
    init { require(path.isAbsolute) { "Library input requires an absolute virtual path" } }
    fun createLibrary(): MemoryKotlinLibrary = MemoryKotlinLibrary(path, files).also { it.attachMemoryKlibFiles(files) }
}

/**
 * Explicit approved-library lookup, retaining the selected loader's platform/ABI checks and stdlib-first order.
 * Missing/malformed input and any compatibility problem are fatal to the browser profile, including problems
 * which the filesystem CLI normally reports at INFO/WARNING severity.
 */
fun loadMemoryKlibs(
    inputs: List<MemoryKlibInput>,
    platformChecker: KlibPlatformChecker,
    minPermittedAbiVersion: KotlinAbiVersion = KotlinAbiVersion.FIRST_SUPPORTED,
    maxPermittedAbiVersion: KotlinAbiVersion = KotlinAbiVersion.CURRENT,
    minSupportedCompilerVersionHint: String? = KotlinAbiVersion.FIRST_SUPPORTED_COMPILER_VERSION,
): KlibLoaderResult {
    require(inputs.size <= 256) { "Too many approved KLIB inputs" }
    require(inputs.map { it.path }.distinct().size == inputs.size) { "Duplicate approved KLIB path" }
    val librariesStdlibFirst = mutableListOf<KotlinLibrary>()
    val problematicLibraries = mutableListOf<ProblematicLibrary>()
    for (input in inputs) {
        val library = input.createLibrary()
        val platformMismatch = platformChecker.check(library)
        if (platformMismatch != null) {
            problematicLibraries.add(ProblematicLibrary(input.path.value, platformMismatch))
            continue
        }
        // The comparisons below retain the exact selected KlibLoader.loadSingleLibrary ABI rules.
        if (library.hasAbi) {
            val libraryAbiVersion: KotlinAbiVersion? = library.versions.abiVersion
            if (libraryAbiVersion == null
                || !libraryAbiVersion.isAtLeast(minPermittedAbiVersion)
                || !libraryAbiVersion.isAtMost(maxPermittedAbiVersion)
            ) {
                problematicLibraries.add(ProblematicLibrary(input.path.value, IncompatibleAbiVersion(
                    library.versions, minPermittedAbiVersion, maxPermittedAbiVersion, minSupportedCompilerVersionHint,
                )))
                continue
            }
        }
        if (library.isAnyPlatformStdlib) librariesStdlibFirst.add(0, library) else librariesStdlibFirst.add(library)
    }
    return KlibLoaderResult(librariesStdlibFirst, problematicLibraries)
}

/** Canonical virtual locations are already validated; no host existence or realpath probing is performed. */
fun KlibLoaderResult.selectMemoryLibrariesByPaths(paths: List<LibraryPath>): List<KotlinLibrary> {
    val byPath = librariesStdlibFirst.associateBy { it.canonicalPath }
    return paths.distinct().map { path -> byPath[path.toAbsolutePath()] ?: error("Approved KLIB not loaded: $path") }
}
