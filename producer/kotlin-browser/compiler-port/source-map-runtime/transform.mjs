import assert from 'node:assert/strict';
export const ROOT = 'js/js.parser/src/org/jetbrains/kotlin/js/parser/sourcemaps/';
export const RUNTIME_PATHS = ['SourceMap.kt', 'SourceMapParser.kt', 'SourceMapLocationRemapper.kt'].map(name => ROOT + name);
export const UTILS = 'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/transformers/irToJs/jsAstUtils.kt';
function replace(text, from, to, changes) {
    assert.equal(text.split(from).length, 2, 'Expected one exact binding span: ' + from);
    changes.push({ from, to }); return text.replace(from, to);
}
export function bindRuntime(filename, bytes) {
    let text = bytes.toString(); const changes = [];
    if (filename === ROOT + 'SourceMap.kt') {
        text = replace(text, 'import java.io.*', `import org.jetbrains.kotlin.js.util.AstSourceReader as Reader
import org.jetbrains.kotlin.js.portable.sourcemap.SourceMapTextFile as File
import org.jetbrains.kotlin.js.portable.sourcemap.SourceMapPrintOutput as PrintStream
import org.jetbrains.kotlin.js.portable.sourcemap.SourceMapIoFailure as IOException
import org.jetbrains.kotlin.js.portable.sourcemap.SourceMapRuntime
import org.jetbrains.kotlin.js.portable.sourcemap.captureSourceMapDebug
import org.jetbrains.kotlin.js.portable.sourcemap.useSourceMapWriter
import org.jetbrains.kotlin.portable.assertions.compilerAssert as assert
import kotlin.text.Appendable as Writer`, changes);
        text = replace(text, 'class SourceMap(val sourceContentResolver: (String) -> Reader?) {',
            'class SourceMap(val runtime: SourceMapRuntime, val sourceContentResolver: (String) -> Reader?) {', changes);
        text = replace(text, 'ByteArrayOutputStream().also { debug(PrintStream(it)) }.toString()', 'captureSourceMapDebug { debug(it) }', changes);
        text = replace(text, 'fun debug(writer: PrintStream = System.out)', 'fun debug(writer: PrintStream = runtime.printOutput)', changes);
        text = replace(text, '"$generatedJsFile does not exist!"', '"${generatedJsFile.displayPath} does not exist!"', changes);
        text = replace(text, 'sourceMapFile.readText()', 'sourceMapFile.readUtf8Text()', changes);
        text = replace(text, 'sourceMapFile.writer().buffered().use', 'sourceMapFile.openBufferedWriter().useSourceMapWriter', changes);
    } else if (filename === ROOT + 'SourceMapParser.kt') {
        text = replace(text, 'import java.io.File\nimport java.io.IOException\nimport java.io.StringReader', `import org.jetbrains.kotlin.js.portable.sourcemap.SourceMapTextFile as File
import org.jetbrains.kotlin.js.portable.sourcemap.SourceMapIoFailure as IOException
import org.jetbrains.kotlin.js.portable.sourcemap.SourceMapRuntime
import org.jetbrains.kotlin.js.util.AstStringReader as StringReader`, changes);
        text = replace(text, 'fun parse(file: File): SourceMapParseResult', 'fun parse(file: File, runtime: SourceMapRuntime): SourceMapParseResult', changes);
        text = replace(text, 'parse(file.readText(Charsets.UTF_8))', 'parse(file.readUtf8Text(), runtime)', changes);
        text = replace(text, 'fun parse(content: String): SourceMapParseResult', 'fun parse(content: String, runtime: SourceMapRuntime): SourceMapParseResult', changes);
        text = replace(text, 'return parse(jsonObject)', 'return parse(jsonObject, runtime)', changes);
        text = replace(text, 'private fun parse(jsonObject: JsonNode): SourceMapParseResult', 'private fun parse(jsonObject: JsonNode, runtime: SourceMapRuntime): SourceMapParseResult', changes);
        text = replace(text, 'val sourceMap = SourceMap {', 'val sourceMap = SourceMap(runtime) {', changes);
    } else {
        assert.equal(filename, ROOT + 'SourceMapLocationRemapper.kt');
        // The original Java JsFunction getter has platform nullability; dereferencing
        // a genuine null body fails here rather than changing traversal behavior.
        text = replace(text, 'x.body.statements.forEach { accept(it) }', '(x.body ?: throw NullPointerException("Cannot invoke \\"org.jetbrains.kotlin.js.backend.ast.JsBlock.getStatements()\\" because the return value of \\"org.jetbrains.kotlin.js.backend.ast.JsFunction.getBody()\\" is null")).statements.forEach { accept(it) }', changes);
    }
    return { bytes: Buffer.from(text), changes };
}
export function bindConsumer(bytes) {
    let text = bytes.toString(); const changes = [];
    // Other ErrorReportingContext functions in this file retain their original API.
    for (const suffix of ['fun IrFunction.getJsCode()', 'private fun parseSourceMap(']) {
        text = replace(text, 'context(reportingContext: ErrorReportingContext)\n' + suffix,
            'context(reportingContext: LoweringContext)\n' + suffix, changes);
    }
    text = replace(text, 'import org.jetbrains.kotlin.backend.common.ErrorReportingContext',
        'import org.jetbrains.kotlin.backend.common.ErrorReportingContext\nimport org.jetbrains.kotlin.backend.common.LoweringContext\nimport org.jetbrains.kotlin.js.portable.sourcemap.requestSourceMapRuntime', changes);
    text = replace(text, 'SourceMapParser.parse(sourceMap)',
        'SourceMapParser.parse(sourceMap, requestSourceMapRuntime(reportingContext.configuration))', changes);
    return { bytes: Buffer.from(text), changes };
}
