/*
 * Copyright 2026 wasm-llvm contributors.
 * Dot component normalization follows Kotlin FilePathComponents.kt and Utils.kt:
 * Copyright 2010-2018 and 2010-2020 JetBrains s.r.o. and Kotlin Programming Language contributors.
 * Governed by Apache-2.0, as in the pinned originals.
 */
package org.jetbrains.kotlin.js.portable.sourcemap

import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.config.CompilerConfigurationKey

/** Explicit POSIX lexical paths, presence lookup and mapping diagnostics for one request. */
class SourceMapPathHost(
    workingDirectory: String,
    private val presence: (SourceMapPosixPath) -> Boolean,
    val diagnostics: SourceMapEmbeddingDiagnostics,
    outputDirectory: String?,
) {
    val workingDirectory = SourceMapPosixPath(this, workingDirectory, normalizeSlashes = false)
    init { require(this.workingDirectory.isAbsolute) { "Source map working directory must be absolute" } }
    val outputDirectory: SourceMapPosixPath? = outputDirectory?.let(::path)
    val builderHost: SourceMapBuilderHost get() = SourceMapBuilderHost('/', diagnostics)
    fun path(value: String): SourceMapPosixPath = SourceMapPosixPath(this, value)
    fun join(parent: SourceMapPosixPath, child: String): SourceMapPosixPath {
        val prefix = parent.path.ifEmpty { "/" }
        val suffix = path(child).path
        return SourceMapPosixPath(this, when {
            suffix.isEmpty() -> prefix
            suffix.startsWith('/') -> if (prefix == "/") suffix else prefix + suffix
            prefix == "/" -> prefix + suffix
            else -> "$prefix/$suffix"
        }, normalizeSlashes = false)
    }
    internal fun exists(file: SourceMapPosixPath): Boolean = '\u0000' !in file.path && presence(file)
}

/** Case-sensitive slash-normalized spelling; dot normalization is a separate selected operation. */
class SourceMapPosixPath internal constructor(private val host: SourceMapPathHost, value: String, normalizeSlashes: Boolean = true) {
    val path: String = if (!normalizeSlashes || value.isEmpty()) value else {
        val parts = value.split('/').filter { it.isNotEmpty() }
        (if (value.startsWith('/')) "/" else "") + parts.joinToString("/")
    }
    val isAbsolute: Boolean get() = path.startsWith('/')
    val name: String get() = path.substringAfterLast('/')
    val parentFile: SourceMapPosixPath? get() {
        val index = path.lastIndexOf('/')
        return when { index < 0 || path == "/" -> null; index == 0 -> host.path("/"); else -> host.path(path.substring(0, index)) }
    }
    val absoluteFile: SourceMapPosixPath get() = if (isAbsolute) this else host.join(host.workingDirectory, path)
    fun normalize(): SourceMapPosixPath {
        // Genuine Kotlin FilePathComponents also recognizes colon roots on POSIX.
        fun rootLength(value: String): Int {
            val first = value.indexOf('/')
            return when { first == 0 -> 1; first > 0 && value[first - 1] == ':' -> first + 1; first == -1 && value.endsWith(':') -> value.length; else -> 0 }
        }
        val rootLength = rootLength(path)
        val root = path.substring(0, rootLength)
        val suffix = path.substring(rootLength)
        val segments = ArrayList<String>()
        if (suffix.isNotEmpty()) for (segment in suffix.split('/')) when (segment) {
            "." -> {}
            ".." -> if (segments.isNotEmpty() && segments.last() != "..") segments.removeAt(segments.lastIndex) else segments.add(segment)
            else -> segments.add(segment)
        }
        val body = segments.joinToString("/")
        return host.path(if (rootLength(body) > 0) body else if (root.isEmpty() || root.endsWith('/')) root + body else if (body.isEmpty()) root else "$root/$body")
    }
    fun exists(): Boolean = host.exists(this)
    override fun equals(other: Any?): Boolean = other is SourceMapPosixPath && path == other.path
    override fun hashCode(): Int = path.hashCode() xor 1234321
    override fun toString(): String = path
}

private val REQUEST_SOURCE_MAP_PATH_HOST = CompilerConfigurationKey.create<SourceMapPathHost>("request source map POSIX path host")
fun installRequestSourceMapPathHost(configuration: CompilerConfiguration, host: SourceMapPathHost) {
    configuration.put(REQUEST_SOURCE_MAP_PATH_HOST, host)
}
fun requestSourceMapPathHost(configuration: CompilerConfiguration): SourceMapPathHost =
    requireNotNull(configuration[REQUEST_SOURCE_MAP_PATH_HOST]) { "Source map path host is not installed for this request" }
