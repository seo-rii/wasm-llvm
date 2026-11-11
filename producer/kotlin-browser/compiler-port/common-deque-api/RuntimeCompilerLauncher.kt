package org.jetbrains.kotlin.portable.deque.runtime

import java.io.File

// This launcher only authenticates class origins and delegates to the official
// CLI. It does not select declarations or alter compiler IR or diagnostics.
fun main(arguments: Array<String>) {
    require(arguments.size >= 2)
    val overlay = File(arguments[0]).canonicalFile
    val compiler = File(arguments[1]).canonicalFile
    val classes = listOf(
        "org.jetbrains.kotlin.ir.backend.js.dce.UsefulDeclarationProcessor" to overlay,
        "org.jetbrains.kotlin.ir.inline.FunctionInlining" to overlay,
        "org.jetbrains.kotlin.backend.common.linkage.partial.PartiallyLinkedIrTreePatcher" to overlay,
        "org.jetbrains.kotlin.resolve.calls.inference.components.ConstraintIncorporator" to overlay,
        "org.jetbrains.kotlin.types.TypeCheckerState" to overlay,
        "org.jetbrains.kotlin.types.AbstractTypeChecker" to overlay,
        "org.jetbrains.kotlin.types.AbstractNullabilityChecker" to overlay,
        "org.jetbrains.kotlin.types.checker.UtilsKt" to overlay,
        "org.jetbrains.kotlin.fir.types.FirCorrespondingSupertypesCache" to overlay,
        "org.jetbrains.kotlin.resolve.calls.NewCommonSuperTypeCalculator" to overlay,
        "org.jetbrains.kotlin.types.model.TypeSystemContext" to overlay,
        "org.jetbrains.kotlin.types.model.TypeSystemCommonSuperTypesContext" to overlay,
        "org.jetbrains.kotlin.types.checker.NewKotlinTypeCheckerKt" to overlay,
        "org.jetbrains.kotlin.backend.wasm.WasmBackendContext" to compiler,
        "org.jetbrains.kotlin.cli.js.KotlinWasmCompiler" to compiler,
    )
    for (entry in classes) {
        val name = entry.first
        val expected = entry.second
        val type = Class.forName(name)
        val actual = File(type.protectionDomain.codeSource.location.toURI()).canonicalFile
        check(actual == expected) { "Unexpected origin for $name: $actual" }
        System.err.println("DEQUE_ORIGIN\t$name\t${actual.path}")
    }
    Class.forName("org.jetbrains.kotlin.cli.js.KotlinWasmCompiler")
        .getMethod("main", Array<String>::class.java)
        .invoke(null, arguments.drop(2).toTypedArray())
}
