/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.portable.tower

fun compareUnsigned(left: Long, right: Long): Int = left.toULong().compareTo(right.toULong())

fun toBinaryString(value: Long): String = value.toULong().toString(2)
