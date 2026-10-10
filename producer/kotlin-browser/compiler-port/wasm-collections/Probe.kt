/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.portable.wasmcollections.probe

import org.jetbrains.kotlin.wasm.ir.*
import org.jetbrains.kotlin.backend.wasm.ir2wasm.LiteralGlobalSymbol

data class MetadataAnnotation(val functionIndex: Int, val kind: Int, val byteOffset: Int, val value: Int)

// Ordinary equal/colliding fixture keys; the full IdSignature owner graph is outside this observer.
data class ProbeSignature(val text: String) {
    override fun hashCode(): Int = text.length % 3
}

fun observeWasmCollections(): String = buildString {
    fun emit(value: String) { append(value).append('\n') }
    val functionTypes = FunctionTypeProbe()
    var eagerCalls = 0
    repeat(256) { index ->
        val key = ProbeSignature("signature_${index % 17}")
        val value = WasmFunctionType(listOf(if (index % 2 == 0) WasmI32 else WasmI64), emptyList())
        eagerCalls++
        functionTypes.referenceWasmFunctionType(key, value)
        functionTypes.referenceWasmFunctionHeapType(ProbeSignature(key.text), value)
        functionTypes.registerContinuation(ProbeSignature(key.text), value)
        val retained = functionTypes.values.getValue(key)
        emit("function:$index:${retained.parameterTypes.single().name}:${retained === value}:${functionTypes.values.size}:$eagerCalls")
    }
    val literals = LiteralProbe()
    val batches = listOf(listOf("a", "b", "a", ""), listOf("b", "c", "c", "d"), emptyList(), listOf("a", "e"))
    for ((index, batch) in batches.withIndex()) {
        val old = literals.globalLiteralGlobals.toMap()
        literals.bind(batch.map(::LiteralGlobalSymbol))
        for ((key, value) in literals.globalLiteralGlobals) {
            emit("literal:$index:${key.length}:$key:${value.name}:${value.importPair!!.declarationName.owner}:${value.type}:${value.isMutable}:${value.init.size}:${old[key] === value}")
        }
        emit("literal-counter:$index:${literals.globalCounter}")
    }
    literals.throwImport = true
    literals.bind(listOf(LiteralGlobalSymbol("a"))) // A hit never evaluates the throwing factory.
    emit("literal-hit-counter:${literals.globalCounter}")
    try { literals.bind(listOf(LiteralGlobalSymbol("failure"))) }
    catch (failure: IllegalStateException) { emit("literal-failure:${failure.message}:${literals.globalCounter}:${literals.globalLiteralGlobals.containsKey("failure")}") }
    literals.throwImport = false
    literals.bind(listOf(LiteralGlobalSymbol("failure")))
    emit("literal-retry:${literals.globalLiteralGlobals.getValue("failure").name}:${literals.globalCounter}")

    fun metadata(input: List<MetadataAnnotation>, label: String) {
        val bytes = metadataBytes(input)
        emit("metadata:$label:" + bytes.joinToString("") { it.toUByte().toString(16).padStart(2, '0') })
    }
    metadata(emptyList(), "empty")
    metadata(listOf(MetadataAnnotation(7, 2, 5, 0), MetadataAnnotation(0, 0, 127, 1),
        MetadataAnnotation(7, 0, 128, 0), MetadataAnnotation(2, 1, 16384, -64),
        MetadataAnnotation(0, 0, 127, 0), MetadataAnnotation(2, 1, 0, Int.MIN_VALUE)), "ordered-boundaries")
    var seed = 0x12345678
    repeat(1024) { test ->
        val items = mutableListOf<MetadataAnnotation>()
        repeat(test % 23) {
            seed = seed * 1664525 + 1013904223
            val id = seed ushr 1
            items.add(MetadataAnnotation(id % 37, id % 3, (id ushr 6) % 20000, seed))
        }
        metadata(items, test.toString())
    }
}
