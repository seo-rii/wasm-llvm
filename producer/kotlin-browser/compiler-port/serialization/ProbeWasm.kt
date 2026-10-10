@file:OptIn(kotlin.js.ExperimentalJsExport::class, kotlin.js.ExperimentalWasmJsInterop::class)
package org.jetbrains.kotlin.protobuf.probe

import kotlin.js.JsAny
import kotlin.js.JsExport
import kotlin.JsFun
import org.jetbrains.kotlin.protobuf.InvalidProtocolBufferException

@JsFun("(bytes) => bytes.length")
external fun inputLength(bytes: JsAny): Int
@JsFun("(bytes, index) => bytes[index]")
external fun inputByte(bytes: JsAny, index: Int): Int
@JsFun("(length) => new Uint8Array(length)")
external fun outputBytes(length: Int): JsAny
@JsFun("(bytes, index, value) => { bytes[index] = value; }")
external fun outputByte(bytes: JsAny, index: Int, value: Int)

@JsExport
fun codecVerifyGeneratedApi(): Boolean = verifyGeneratedApi()

@JsExport
fun codecDecode(name: String, input: JsAny, partial: Boolean, extensions: Boolean, recursionLimit: Int): JsAny {
    val length = inputLength(input)
    require(length in 0..64*1024*1024)
    val bytes = ByteArray(length) { val value = inputByte(input,it); require(value in 0..255); value.toByte() }
    val result = decodeForProbe(name,bytes,partial,extensions,recursionLimit)
    val output = outputBytes(result.size)
    for (index in result.indices) outputByte(output,index,result[index].toInt() and 255)
    return output
}
