@file:OptIn(kotlin.js.ExperimentalJsExport::class, kotlin.js.ExperimentalWasmJsInterop::class)

package org.jetbrains.kotlin.portable.linkerprobe

import org.jetbrains.kotlin.library.impl.VerifiedKlibFileSet
import org.jetbrains.kotlin.portable.linker.jarImplementationVersion
import kotlin.js.*

@JsFun("(bytes) => bytes.byteLength") private external fun bufferLength(bytes: JsAny): Int
@JsFun("(bytes, index) => bytes[index]") private external fun bufferByte(bytes: JsAny, index: Int): Int
@JsFun("(length) => new Uint8Array(length)") private external fun makeOutput(length: Int): JsAny
@JsFun("(bytes, index, value) => { bytes[index] = value; }") private external fun setByte(bytes: JsAny, index: Int, value: Int)

private val files = mutableMapOf<String, ByteArray>()

@JsExport
fun writerProbeAddFile(path: String, bytes: JsAny) {
    require(files.size < VerifiedKlibFileSet.MAX_FILES && path !in files)
    val size = bufferLength(bytes)
    require(size in 0..64 * 1024 * 1024)
    files[path] = ByteArray(size) { index -> val value = bufferByte(bytes, index); require(value in 0..255); value.toByte() }
}

@JsExport
fun writerProbeSnapshot(): JsAny {
    val bytes = portableWriterSnapshot(files)
    val output = makeOutput(bytes.size)
    bytes.forEachIndexed { index, value -> setByte(output, index, value.toInt() and 255) }
    return output
}

@JsExport fun writerProbeJars(): String = jarObservation(::jarImplementationVersion)
@JsExport fun writerProbeGuards(): String = portableChecks(files)
