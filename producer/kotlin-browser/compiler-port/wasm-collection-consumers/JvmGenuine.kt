/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.portable.wasmconsumers.probe

import org.jetbrains.kotlin.ir.util.IdSignature
import org.jetbrains.kotlin.wasm.ir.*

fun main() = print(buildString {
    repeat(256) { test ->
        val values = mutableMapOf<IdSignature, WasmFunctionType>()
        repeat(test % 29) { index ->
            val signature = IdSignature.CommonSignature("probe.pkg", "function${index % 17}", (index % 17).toLong(), 0L, null)
            val value = WasmFunctionType(List(index % 4) { WasmI32 }, if (index % 3 == 0) listOf(WasmI64) else emptyList()).also { it.id = index }
            values[signature] = value
        }
        val prior = values.toMap()
        val bootstrapReverse = BootstrapReverse.apply(values)
        val lockedReverse = values.declaredReverseSelected()
        check(bootstrapReverse == lockedReverse)
        canonicalizeSelected(values)
        for ([signature, value] in values) {
            val canonical = bootstrapReverse.getValue(value)
            check(value === prior.getValue(canonical))
            append("genuine:").append(test).append(':').append(signature.toString()).append('\t').append(value.id).append('\n')
        }
        append("bootstrap-helper:").append(test).append('\t').append(lockedReverse.entries.joinToString(",") { it.value.toString() }).append('\n')
    }
})
