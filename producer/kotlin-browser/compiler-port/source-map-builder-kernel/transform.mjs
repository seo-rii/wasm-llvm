import assert from 'node:assert/strict';
export const ROOT = 'js/js.sourcemap/src/org/jetbrains/kotlin/js/sourceMap/';
export const BUILDER = ROOT + 'SourceMap3Builder.kt';
export const CONSUMER = ROOT + 'SourceMapMappingConsumer.java';
export const PREFIX = 'compiler-port-source-map-builder-kernel/';
function replace(text, from, to, changes) {
    assert.equal(text.split(from).length, 2, 'Expected one exact source binding: ' + from);
    changes.push({ from, to }); return text.replace(from, to);
}
export function bindSourceMapBuilder(filename, bytes) {
    let text = bytes.toString(); const changes = [];
    if (filename === BUILDER) {
        text = replace(text, 'import it.unimi.dsi.fastutil.objects.Object2IntOpenHashMap\n', '', changes);
        text = replace(text, 'import java.io.File\nimport java.io.IOException\nimport java.io.Reader\nimport java.util.function.Supplier',
            'import org.jetbrains.kotlin.js.util.AstSourceReader as Reader\n' +
            'import org.jetbrains.kotlin.js.portable.sourcemap.SourceMapContentSupplier as Supplier\n' +
            'import org.jetbrains.kotlin.js.portable.sourcemap.SourceMapBuilderHost\n' +
            'import org.jetbrains.kotlin.js.portable.sourcemap.isSourceMapEmbeddingIoFailure\n' +
            'import org.jetbrains.kotlin.js.portable.sourcemap.readSourceMapEmbeddingText\n' +
            'import org.jetbrains.kotlin.js.portable.sourcemap.useSourceMapEmbeddingReader', changes);
        text = replace(text, 'private val generatedFile: File?', 'private val generatedFileName: String?', changes);
        text = replace(text, 'private val pathPrefix: String\n', 'private val pathPrefix: String,\n    private val host: SourceMapBuilderHost\n', changes);
        text = replace(text, 'if (generatedFile != null)\n            json.properties["file"] = JsonString(generatedFile.name)',
            'if (generatedFileName != null)\n            json.properties["file"] = JsonString(generatedFileName)', changes);
        text = replace(text, 'it.get().use { reader ->', 'it.get().useSourceMapEmbeddingReader { reader ->', changes);
        text = replace(text, 'reader.readText()', 'reader.readSourceMapEmbeddingText()', changes);
        text = replace(text, '} catch (e: IOException) {', '} catch (e: Exception) {\n                    if (!isSourceMapEmbeddingIoFailure(e)) throw e', changes);
        text = replace(text, 'System.err.println("An exception occurred during embedding sources into source map")',
            'host.diagnostics.println("An exception occurred during embedding sources into source map")', changes);
        text = replace(text, 'e.printStackTrace()', 'host.diagnostics.reportThrowable(e)', changes);
        text = replace(text, 'sources.getInt(key)', '(sources[key] ?: -1)', changes);
        text = replace(text, 'names.getInt(name)', '(names[name] ?: -1)', changes);
        assert.equal(text.split('Supplier<Reader?>').length - 1, 5);
        text = text.replaceAll('Supplier<Reader?>', 'Supplier');
        changes.push({ from: 'Supplier<Reader?>', to: 'Supplier', occurrences: 5 });
        text = replace(text, "replace(File.separatorChar, '/')", "replace(host.separatorChar, '/')", changes);
        text = replace(text, 'private fun <T> createOpenHashMap() = Object2IntOpenHashMap<T>().apply {\n        defaultReturnValue(-1)\n    }',
            'private fun <T> createOpenHashMap() = mutableMapOf<T, Int>()', changes);
    } else {
        assert.equal(filename, CONSUMER);
        const header = text.slice(0, text.indexOf('package '));
        assert.equal((text.match(/\bvoid\s+\w+\(/g) ?? []).length, 3);
        assert(text.includes('@NotNull Supplier<Reader> sourceSupplier'));
        text = header + `package org.jetbrains.kotlin.js.sourceMap

import org.jetbrains.kotlin.js.portable.sourcemap.SourceMapContentSupplier

interface SourceMapMappingConsumer {
    fun newLine()
    fun addMapping(
        source: String,
        fileIdentity: Any?,
        sourceSupplier: SourceMapContentSupplier,
        sourceLine: Int,
        sourceColumn: Int,
        name: String?,
    )
    fun addEmptyMapping()
}
`;
        changes.push({ binding: 'Complete three-method Java interface; genuine nullable supplier result and explicit request source reader' });
    }
    return { bytes: Buffer.from(text), changes };
}
