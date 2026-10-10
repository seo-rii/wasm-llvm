import assert from 'node:assert/strict';
export const ROOT = 'js/js.sourcemap/src/org/jetbrains/kotlin/js/sourceMap/';
export const RELATIVE = ROOT + 'RelativePathCalculator.kt', RESOLVER = ROOT + 'SourceFilePathResolver.kt', CONSUMER = ROOT + 'SourceMapBuilderConsumer.kt';
export const INFO = 'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/SourceMapsInfo.kt';
export const OUTLINING = 'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/lower/JsCodeOutliningLowering.kt';
export const GENERATOR = 'compiler/ir/backend.wasm/src/org/jetbrains/kotlin/backend/wasm/utils/SourceMapGenerator.kt';
export const PREFIX = 'compiler-port-source-map-path-consumer/';
export const PATH_SOURCES = [RELATIVE,RESOLVER,CONSUMER,INFO,OUTLINING,GENERATOR];
function replace(text, from, to, changes) { const count = text.split(from).length - 1; assert(count > 0, 'Missing exact source span: ' + from); changes.push({ from, to, count }); return text.split(from).join(to); }
export function bindSourceMapPaths(filename, bytes) {
    let text = bytes.toString(); const changes = [];
    const r = (from,to) => { text = replace(text,from,to,changes); };
    if ([RELATIVE,RESOLVER,CONSUMER,INFO].includes(filename)) r('import java.io.File', 'import org.jetbrains.kotlin.js.portable.sourcemap.SourceMapPosixPath as File');
    if (filename === RELATIVE) {} else if (filename === RESOLVER) {
        r('import java.io.IOException', 'import org.jetbrains.kotlin.js.portable.sourcemap.SourceMapIoFailure as IOException\nimport org.jetbrains.kotlin.js.portable.sourcemap.SourceMapPathHost\nimport kotlin.jvm.JvmStatic');
        r('class SourceFilePathResolver(\n', 'class SourceFilePathResolver(\n    val host: SourceMapPathHost,\n');
        r('parts.joinToString(File.separator)', 'parts.joinToString("/")');
        r('            sourceRoots: List<String>,', '            host: SourceMapPathHost,\n            sourceRoots: List<String>,');
        r('                sourceRoots.map(::File),', '                host,\n                sourceRoots.map(host::path),');
    } else if (filename === CONSUMER) {
        r('import java.io.IOException', 'import org.jetbrains.kotlin.js.portable.sourcemap.SourceMapIoFailure as IOException\nimport org.jetbrains.kotlin.js.portable.sourcemap.SourceMapContentSupplier');
        r('        val contentSupplier = if (provideExternalModuleContent) sourceInfo.sourceProvider else {\n            { null }\n        }', '        val contentSupplier = if (provideExternalModuleContent) SourceMapContentSupplier(sourceInfo.sourceProvider) else SourceMapContentSupplier { null }');
        r('val sourceFile = File(sourceInfo.file)', 'val sourceFile = pathResolver.host.path(sourceInfo.file)');
        r('File(sourceBaseDir, sourceInfo.file)', 'pathResolver.host.join(sourceBaseDir, sourceInfo.file)');
        r('                { null },', '                SourceMapContentSupplier { null },');
    } else if (filename === INFO) {
        r('import org.jetbrains.kotlin.config.CompilerConfiguration', 'import org.jetbrains.kotlin.js.portable.sourcemap.requestSourceMapPathHost\nimport org.jetbrains.kotlin.config.CompilerConfiguration');
        r('configuration.get(JSConfigurationKeys.OUTPUT_DIR)', 'requestSourceMapPathHost(configuration).outputDirectory');
    } else if (filename === OUTLINING) {
        r('import java.io.File', 'import org.jetbrains.kotlin.js.portable.sourcemap.requestSourceMapPathHost');
        r('        val sourceMapBuilder = SourceMap3Builder(', '        val sourceMapHost = requestSourceMapPathHost(loweringContext.configuration)\n        val sourceMapBuilder = SourceMap3Builder(');
        r('            generatedFile = null,', '            generatedFileName = null,');
        r('            pathPrefix = "",\n', '            pathPrefix = "",\n            host = sourceMapHost.builderHost,\n');
        r('            File("."),', '            sourceMapHost.path("."),');
        r('            SourceFilePathResolver(emptyList()),', '            SourceFilePathResolver(sourceMapHost, emptyList()),');
    } else {
        assert.equal(filename,GENERATOR);
        r('import java.io.File', 'import org.jetbrains.kotlin.js.portable.sourcemap.requestSourceMapPathHost');
        r('        val sourceMapBuilder =\n', '        val sourceMapHost = requestSourceMapPathHost(configuration)\n        val sourceMapBuilder =\n');
        r('sourceMapsInfo.sourceMapPrefix)', 'sourceMapsInfo.sourceMapPrefix, sourceMapHost.builderHost)');
        r('SourceFilePathResolver.create(\n', 'SourceFilePathResolver.create(\n            sourceMapHost,\n');
        r('getPathRelativeToSourceRootsIfExists(File(sourceLocation.file))', 'getPathRelativeToSourceRootsIfExists(sourceMapHost.path(sourceLocation.file))');
    }
    return { bytes: Buffer.from(text), changes };
}
