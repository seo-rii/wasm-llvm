package org.jetbrains.kotlin.ir.backend.js

import org.jetbrains.kotlin.backend.common.LoadedKlibs
import org.jetbrains.kotlin.backend.common.eliminateLibrariesWithDuplicatedUniqueNames
import org.jetbrains.kotlin.backend.common.reportLoadingProblemsIfAny
import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.config.DuplicatedUniqueNameStrategy
import org.jetbrains.kotlin.config.duplicatedUniqueNameStrategy
import org.jetbrains.kotlin.config.skipLibrarySpecialCompatibilityChecks
import org.jetbrains.kotlin.ir.backend.js.checkers.WasmLibrarySpecialCompatibilityChecker
import org.jetbrains.kotlin.library.loader.KlibPlatformChecker
import org.jetbrains.kotlin.library.uniqueName
import org.jetbrains.kotlin.portable.linker.MemoryKlibInput
import org.jetbrains.kotlin.portable.linker.loadMemoryKlibs
import org.jetbrains.kotlin.portable.linker.selectMemoryLibrariesByPaths
import org.jetbrains.kotlin.portable.source.LibraryPath

/** Official Web KLIB entry semantics with an explicit verified-memory provider and strict initial profile. */
fun loadMemoryWebKlibs(
    configuration: CompilerConfiguration,
    inputs: List<MemoryKlibInput>,
    target: String,
    friends: List<LibraryPath> = emptyList(),
    included: LibraryPath? = null,
): LoadedKlibs {
    require(target == "wasm-wasi") { "The browser console profile only admits wasm-wasi target libraries" }
    require(!configuration.skipLibrarySpecialCompatibilityChecks) { "Library special compatibility checks must be enabled" }
    require(configuration.duplicatedUniqueNameStrategy.let { it == null || it == DuplicatedUniqueNameStrategy.DENY }) {
        "The browser profile rejects duplicate KLIB unique names"
    }
    val result = loadMemoryKlibs(inputs, KlibPlatformChecker.Wasm(target))
    result.reportLoadingProblemsIfAny(configuration, allAsErrors = true)
    check(!result.hasProblems) { "An approved KLIB did not pass its platform/ABI checks" }
    result.eliminateLibrariesWithDuplicatedUniqueNames(configuration)
    check(result.librariesStdlibFirst.map { it.uniqueName }.distinct().size == result.librariesStdlibFirst.size) {
        "Approved KLIB unique names are duplicated"
    }
    return LoadedKlibs(
        all = result.librariesStdlibFirst,
        friends = result.selectMemoryLibrariesByPaths(friends),
        included = included?.let { result.selectMemoryLibrariesByPaths(listOf(it)).single() },
    ).also { WasmLibrarySpecialCompatibilityChecker.check(it.all, configuration) }
}
