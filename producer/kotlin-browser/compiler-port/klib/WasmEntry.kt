@file:OptIn(kotlin.js.ExperimentalJsExport::class, kotlin.js.ExperimentalWasmJsInterop::class)

package org.jetbrains.kotlin.portable.klibprobe

import org.jetbrains.kotlin.library.components.*
import org.jetbrains.kotlin.library.impl.*
import org.jetbrains.kotlin.portable.klib.ManifestProperties
import org.jetbrains.kotlin.portable.source.LibraryPath
import kotlin.js.*

@JsFun("(bytes) => bytes.byteLength")
private external fun bufferLength(bytes: JsAny): Int
@JsFun("(bytes, index) => bytes[index]")
private external fun bufferByte(bytes: JsAny, index: Int): Int
@JsFun("(length) => new Uint8Array(length)")
private external fun makeOutput(length: Int): JsAny
@JsFun("(bytes, index, value) => { bytes[index] = value; }")
private external fun setOutputByte(bytes: JsAny, index: Int, value: Int)

private val files = mutableListOf<KlibFileEntry>()
private val directories = mutableListOf<String>()

/** The fixture host first checks SHA-256 using SubtleCrypto; only verified immutable Uint8Arrays enter this probe boundary. */
@JsExport
fun klibProbeAddFile(path: String, bytes: JsAny, sha256: String) {
    require(files.size < VerifiedKlibFileSet.MAX_FILES && files.none { it.path == path })
    val size = bufferLength(bytes)
    require(size in 0..64 * 1024 * 1024)
    val copy = ByteArray(size) {
        val value = bufferByte(bytes, it)
        require(value in 0..255)
        value.toByte()
    }
    files.add(KlibFileEntry(path, copy, sha256))
}

@JsExport
fun klibProbeAddDirectory(path: String) { directories.add(path) }

@JsExport
fun klibProbeUnits(): String = unitSnapshot()

@JsExport
fun klibProbeManifests(): String = manifestSnapshot { ManifestProperties.fromText(it).asMap() }

@JsExport
fun klibProbeChecks(): String = portableChecks()

@JsExport
fun klibProbeStdlibSnapshot(): JsAny {
    // The trusted fixture host approves the file index; common Kotlin SHA-256 rechecks every copied byte array here.
    val verified = VerifiedKlibFileSet.verify(files, directories)
    val library = MemoryKotlinLibrary(LibraryPath("/stdlib"), verified)
    val bytes = librarySnapshot(library.manifestProperties.asMap(), library.versions, library.metadata, library.ir, library.inlinableFunctionsIr,
        IrMultiArrayReader(verified.read("default/ir/debugInfo.knd")), IrMultiArrayReader(verified.read("default/ir_inlinable_functions/debugInfo.knd")))
    val output = makeOutput(bytes.size)
    bytes.forEachIndexed { byteIndex, value -> setOutputByte(output, byteIndex, value.toInt() and 255) }
    return output
}
