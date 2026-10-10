/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
@file:OptIn(kotlin.wasm.unsafe.UnsafeWasmMemoryApi::class, kotlin.wasm.ExperimentalWasmInterop::class)

import kotlin.wasm.WasmImport
import kotlin.wasm.unsafe.withScopedMemoryAllocator

@WasmImport("allocator_canary", "boundary")
private external fun boundary(request: Int, pointer: Int, guard: Int, abiBytes: Int, mode: Int)

@WasmImport("allocator_canary", "observed")
private external fun observed(request: Int, pointer: Int, guard: Int, abiBytes: Int, mode: Int, damaged: Int)

private fun measure(request: Int, abiBytes: Int, mode: Int) {
    withScopedMemoryAllocator { allocator ->
        val pointer = allocator.allocate(request)
        val guard = allocator.allocate(64)
        for (index in 0 until request) (pointer + index).storeByte(0x33)
        for (index in 0 until 64) (guard + index).storeByte(0x6A)
        boundary(request, pointer.address.toInt(), guard.address.toInt(), abiBytes, mode)
        var damaged = 0
        for (index in 0 until 64) if ((guard + index).loadByte() != 0x6A.toByte()) damaged++
        observed(request, pointer.address.toInt(), guard.address.toInt(), abiBytes, mode, damaged)
        check(damaged == 0)
    }
}

fun main() {
    // Measure the exact selected allocator, without asserting these distances as a public API.
    for (size in 1..65) measure(size, size, 0)
    for (size in intArrayOf(127, 128, 129, 255, 256, 257, 4095, 4096, 4097, 65535, 65536, 65537)) measure(size, size, 0)
    // A subscription is input: inspect its full ABI span without writing past the allocation.
    measure(20, 48, 1)
    measure(48, 48, 1)
    // An event is output: write the complete structure and check the following allocation.
    measure(26, 32, 2)
    measure(32, 32, 2)
    // The observer returns AGAIN on the first write. This invokes the real patched stdlib poll path.
    print("poll-canary-λ\n")
}
