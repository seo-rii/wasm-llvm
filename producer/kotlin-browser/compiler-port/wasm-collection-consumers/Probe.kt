/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.portable.wasmconsumers.probe

import org.jetbrains.kotlin.wasm.ir.*

// This is an explicit probe-only signature payload, never a shipping IdSignature.
data class SignaturePayload(val text: String) {
    override fun hashCode(): Int = text.length % 3
}

fun observeWasmConsumers(): String = buildString {
    fun emit(label: String, value: Any?) { append(label).append('\t').append(value).append('\n') }
    fun hex(bytes: ByteArray): String = bytes.joinToString("") { it.toUByte().toString(16).padStart(2, '0') }
    fun utf16(value: String): String = value.map { it.code.toString(16).padStart(4, '0') }.joinToString("")
    var seed = 0x12345678
    repeat(1024) { test ->
        val input = mutableMapOf<SignaturePayload, WasmFunctionType>()
        repeat(test % 37) { index ->
            seed = seed * 1664525 + 1013904223
            val shape = (seed ushr 1) % 8
            val value = WasmFunctionType(List(shape % 4) { if (shape and 4 == 0) WasmI32 else WasmI64 },
                if (shape % 3 == 0) listOf(WasmI32) else emptyList()).also { it.id = index }
            input[SignaturePayload("signature_${index % 23}")] = value
        }
        val before = input.toMap()
        canonicalizeSelected(input)
        val identities = input.entries.joinToString(",") { entry ->
            val winner = before.entries.last { it.value == entry.value }
            check(entry.value === winner.value)
            check(input.keys.toList() == before.keys.toList())
            entry.key.text + ":" + entry.value.id + ":" + (entry.value === before[entry.key])
        }
        emit("canonical:$test", identities)
        val first = input.toMap(); canonicalizeSelected(input)
        check(first.all { [key, value] -> input[key] === value })
        emit("canonical-idempotent:$test", true)
    }
    val first = WasmFunctionType(listOf(WasmI32), emptyList()).also { it.id = 1 }
    val equalLast = WasmFunctionType(listOf(WasmI32), emptyList()).also { it.id = 2 }
    check(first !== equalLast && first == equalLast)
    val singleton = mutableMapOf(SignaturePayload("a") to first); canonicalizeSelected(singleton)
    emit("singleton-identity", singleton.values.single() === first)
    val ordered = mutableMapOf(SignaturePayload("a") to first, SignaturePayload("b") to equalLast)
    canonicalizeSelected(ordered); emit("structural-last-identity", ordered.values.all { it === equalLast })
    val reversed = mutableMapOf(SignaturePayload("b") to equalLast, SignaturePayload("a") to first)
    canonicalizeSelected(reversed); emit("reverse-entry-last-identity", reversed.values.all { it === first })

    fun encoded(label: String, value: ULong) {
        val result = encodeSelected(value)
        check(result.length == 9 && result.all { it.code in 0..127 })
        val expected = List(9) { ((value shr (7 * it)) and 127UL).toInt().toChar() }.joinToString("")
        check(result == expected)
        emit("tag:$label", utf16(result))
    }
    for (value in listOf(0UL, 1UL, 127UL, 128UL, ULong.MAX_VALUE, 1UL shl 63, (1UL shl 63) - 1UL)) encoded(value.toString(16), value)
    for (bit in 0..63) encoded("bit:$bit", 1UL shl bit)
    for (slot in 0..8) for (value in 0..127) encoded("slot:$slot:$value", value.toULong() shl (7 * slot))
    var state = 0x123456789abcdef0UL
    repeat(2048) { test -> state = state * 6364136223846793005UL + 1442695040888963407UL; encoded("random:$test", state) }
    check(encodeSelected(0UL) == encodeSelected(1UL shl 63)); emit("high-bit-discarded", true)

    val strings = listOf("", "ascii", "\u0000\u007f", "한글", "🙂", "\ud800", "\udc00", "a\ud800b", "\ud800\ud800\udc00", "\udc00\ud800", "\uffff") +
        (0..260).map { length -> buildString { repeat(length) { index -> append(((index * 37 + length) and 0xffff).toChar()) } } }
    for ([index, value] in strings.withIndex()) {
        val bytes = stringBytesSelected(value)
        val hash = hash128Selected(value)
        emit("utf8:$index", hex(bytes))
        emit("hash128:$index", hash.lowBytes.toString(16) + ":" + hash.highBytes.toString(16))
        emit("declaration-tag:$index", utf16(declarationTagSelected(value)))
    }
    emit("byte-list-overload", hex(byteListSelected(listOf(0, 127, -128, -1).map { it.toByte() })))
}
