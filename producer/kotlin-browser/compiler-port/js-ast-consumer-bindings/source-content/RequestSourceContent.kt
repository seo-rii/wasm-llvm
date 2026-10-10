/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.portable

import org.jetbrains.kotlin.KtSourceFile
import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.config.CompilerConfigurationKey
import org.jetbrains.kotlin.js.util.AstSourceReader
import org.jetbrains.kotlin.js.util.AstStringReader

/** Immutable content owned by one compilation request; keys keep the supplied spelling. */
class RequestSourceContent private constructor(private val content: Map<String, String>) {
    fun openReader(path: String): AstSourceReader? = content[path]?.let { AstStringReader(it) }

    companion object {
        fun snapshot(sources: Iterable<KtSourceFile>): RequestSourceContent {
            val content = LinkedHashMap<String, String>()
            for (source in sources) {
                val path = source.path ?: source.name
                require(!content.containsKey(path)) { "Duplicate source path: $path" }
                content[path] = source.getContentsAsText()
            }
            return RequestSourceContent(content)
        }
    }
}

private val REQUEST_SOURCE_CONTENT = CompilerConfigurationKey.create<RequestSourceContent>("request source content")

/** Install only after the entry has captured the request's input sources. */
fun installRequestSourceContent(configuration: CompilerConfiguration, sources: Iterable<KtSourceFile>) {
    val snapshot = RequestSourceContent.snapshot(sources)
    configuration.put(REQUEST_SOURCE_CONTENT, snapshot)
}

/** Capture this request's immutable value now, rather than looking up future configuration state. */
fun requestSourceSupplier(configuration: CompilerConfiguration, path: String): () -> AstSourceReader? {
    val snapshot = configuration[REQUEST_SOURCE_CONTENT]
    return { snapshot?.openReader(path) }
}
