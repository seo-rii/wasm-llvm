/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.portable.charconstant.probe

import org.jetbrains.kotlin.resolve.constants.CharValue

fun charObservations(): String = buildString {
    append("{\"records\":[")
    for (code in 0..65535) {
        if (code != 0) append(',')
        val value = CharValue(code.toChar())
        append('"').append(code).append(':')
        for (character in value.toString()) {
            append(character.code.toString(16).padStart(4, '0'))
        }
        append('"')
    }
    append("],\"fullConstantsWasmExecuted\":false,\"fullCompilerBuilt\":false}")
}
