/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.portable.sourcemap

import org.jetbrains.kotlin.js.portable.CompilerByteSink
import org.jetbrains.kotlin.js.util.AstSourceReader
import org.jetbrains.kotlin.js.util.AstStringReader
import org.jetbrains.kotlin.portable.text.compilerUtf8String

/** Working byte files owned by one request. Keys retain the caller's exact spelling. */
class SourceMapTextStore(initialFiles: Map<String, ByteArray>) {
    private class FileBytes(var bytes: ByteArray, var length: Int)
    private val files = LinkedHashMap<String, FileBytes>()
    init { for ([path, bytes] in initialFiles) files[path] = FileBytes(bytes.copyOf(), bytes.size) }
    fun file(path: String): SourceMapTextFile = SourceMapTextFile(this, path)
    internal fun exists(path: String): Boolean = files.containsKey(path)
    internal fun readBytes(path: String): ByteArray {
        val value = files[path] ?: throw SourceMapIoFailure("$path (No such file or directory)")
        return value.bytes.copyOf(value.length)
    }
    internal fun overwrite(path: String): CompilerByteSink {
        val file = files.getOrPut(path) { FileBytes(ByteArray(32), 0) }
        file.length = 0
        return object : CompilerByteSink {
            private var position = 0
            private var closed = false
            override fun write(bytes: ByteArray, offset: Int, length: Int) {
                if (offset < 0 || length < 0 || offset > bytes.size - length) throw IndexOutOfBoundsException()
                // FileOutputStream validates the range, then returns for an empty write,
                // even after close or another writer has truncated the shared file.
                if (length == 0) return
                if (closed) throw SourceMapIoFailure("Stream Closed")
                if (length > Int.MAX_VALUE - position) throw SourceMapIoFailure("Byte file exceeds Int capacity")
                val end = position + length
                if (end > file.bytes.size) {
                    val grown = minOf(Int.MAX_VALUE.toLong(), maxOf(end.toLong(), file.bytes.size.toLong() * 2)).toInt()
                    file.bytes = file.bytes.copyOf(grown)
                }
                if (position > file.length) file.bytes.fill(0, file.length, position)
                bytes.copyInto(file.bytes, position, offset, offset + length)
                position = end
                file.length = maxOf(file.length, end)
            }
            override fun flush() {}
            override fun close() { closed = true }
        }
    }
}

class SourceMapTextFile internal constructor(private val store: SourceMapTextStore, val displayPath: String) {
    fun exists(): Boolean = store.exists(displayPath)
    fun readBytes(): ByteArray = store.readBytes(displayPath)
    fun readUtf8Text(): String = readBytes().compilerUtf8String()
    fun openReader(): AstSourceReader = AstStringReader(readUtf8Text())
    fun openOverwriteSink(): CompilerByteSink = store.overwrite(displayPath)
    fun openBufferedWriter(): SourceMapBufferedUtf8Writer = SourceMapBufferedUtf8Writer(openOverwriteSink())
    fun readLines(): List<String> {
        val text = readUtf8Text()
        val result = ArrayList<String>()
        var start = 0
        var offset = 0
        while (offset < text.length) {
            if (text[offset] == '\r' || text[offset] == '\n') {
                result.add(text.substring(start, offset))
                if (text[offset] == '\r' && offset + 1 < text.length && text[offset + 1] == '\n') offset++
                start = offset + 1
            }
            offset++
        }
        if (start < text.length) result.add(text.substring(start))
        return result
    }
}
