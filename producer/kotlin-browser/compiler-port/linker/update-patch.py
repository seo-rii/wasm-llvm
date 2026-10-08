#!/usr/bin/env python3
"""Extract exact official serialization/linking paths and replace only their host I/O boundaries."""
import argparse
import difflib
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parents[3]
LIBRARY = 'compiler/util-klib/src/org/jetbrains/kotlin/library/'
COMMON = 'compiler/ir/serialization.common/src/org/jetbrains/kotlin/backend/common/'
JS = 'compiler/ir/serialization.js/src/org/jetbrains/kotlin/ir/backend/js/'
COMMIT = '4d78aae1e337cd40f69baa865aed950fe807a775'


def replace(text, old, new, count=1):
    assert text.count(old) == count, (old[:90], text.count(old))
    return text.replace(old, new)


def path_import(text):
    return replace(text, 'import java.nio.file.Path\n', 'import org.jetbrains.kotlin.portable.source.LibraryPath as Path\n')


def source_file(text):
    return replace(text, 'import java.io.File\n',
        'import org.jetbrains.kotlin.portable.source.LibraryPath as File\nimport org.jetbrains.kotlin.portable.source.path\n')


def common_serializer(text):
    text = source_file(text)
    text = replace(text, 'import java.util.*\n', 'import org.jetbrains.kotlin.portable.klib.ManifestProperties as Properties\n')
    for line in ['import com.intellij.openapi.vfs.VfsUtilCore\n', 'import org.jetbrains.kotlin.KtIoFileSourceFile\n',
                 'import org.jetbrains.kotlin.KtPsiSourceFile\n', 'import org.jetbrains.kotlin.KtVirtualFileSourceFile\n']:
        text = replace(text, line, '')
    text = replace(text, 'import kotlin.io.path.Path\nimport kotlin.io.path.pathString\n',
        'import org.jetbrains.kotlin.portable.source.LibraryPath as Path\nimport org.jetbrains.kotlin.portable.source.pathString\n')
    begin = text.index('fun KtSourceFile.toIoFileOrNull(): File? = when (this) {')
    end = text.index('\n}\n', begin) + 2
    text = text[:begin] + 'fun KtSourceFile.toIoFileOrNull(): File? = path?.let(::File)' + text[end:]
    return text


def js_klib(text):
    for line in ['import org.jetbrains.kotlin.KtPsiSourceFile\n', 'import org.jetbrains.kotlin.incremental.js.IncrementalDataProvider\n',
                 'import org.jetbrains.kotlin.psi.KtFile\n', 'import java.io.File\n']:
        text = replace(text, line, '')
    text = path_import(text)
    text = replace(text, 'import java.util.*\n', 'import org.jetbrains.kotlin.portable.klib.ManifestProperties as Properties\n')
    text = replace(text, 'get() = manifestProperties.getProperty(KLIB_PROPERTY_UNIQUE_NAME)\n',
        'get() = manifestProperties.getProperty(KLIB_PROPERTY_UNIQUE_NAME) ?: error("KLIB manifest has no module name")\n')
    start = text.index('private typealias ProcessFun = (')
    end = text.index('fun serializeModuleIntoKlib(', start)
    text = text[:start] + text[end:]
    text = replace(text, 'fun serializeModuleIntoKlib(\n', 'fun serializeModuleIntoMemoryKlib(\n')
    text = replace(text, '    nopack: Boolean,\n', '')
    text = replace(text, ') {\n    val incrementalResultsConsumer = configuration.get(JSConfigurationKeys.INCREMENTAL_RESULTS_CONSUMER)\n',
        '): KotlinLibrary {\n    require(cleanFiles.isEmpty()) { "Incremental source sessions are excluded from the browser compiler profile" }\n')
    start = text.index('            processCompiledFileData = incrementalResultsConsumer?.let')
    end = text.index('\n        )\n    }', start)
    text = text[:start] + text[end:]
    text = replace(text, '    performanceManager.tryMeasurePhaseTime(PhaseType.KlibWriting) {\n',
        '    return performanceManager.tryMeasurePhaseTime(PhaseType.KlibWriting) {\n')
    text = replace(text, '            format(if (nopack) KlibFormat.Directory else KlibFormat.ZipArchive)\n', '')
    text = replace(text, '        }.writeTo(klibPath)\n', '        }.writeIntoMemory(klibPath)\n')
    start = text.index('fun <SourceFile> shouldGoToNextIcRound(')
    end = text.index('private fun List<IrModuleFragment>.getUniqueNameForEachFragment()', start)
    text = text[:start] + text[end:]
    text = text[:text.index('\nfun IncrementalDataProvider.getSerializedData(')].rstrip() + '\n'
    # Incremental cache loading is a separate source-set variant; normal full linking strategies remain exact.
    text = replace(text, '    filesToLoad: Set<String>?,\n', '')
    text = replace(text, '            filesToLoad != null && klib == klibs.included -> irLinker.deserializeDirtyFiles(descriptor, klib, filesToLoad)\n', '')
    text = replace(text, '            filesToLoad != null && klib != klibs.included -> irLinker.deserializeHeadersWithInlineBodies(descriptor, klib)\n', '')
    text = replace(text, '        filesToLoad = configuration[JSConfigurationKeys.IC_FILES_TO_LOAD],\n', '')
    text = replace(text, 'import org.jetbrains.kotlin.js.config.JSConfigurationKeys\n', '')
    return text


def writer(text):
    start = text.index('import org.jetbrains.kotlin.io.zipDirAs')
    end = text.index('/**\n * The [KlibWriter]', start)
    text = text[:start] + '''import org.jetbrains.kotlin.library.KotlinLibrary
import org.jetbrains.kotlin.library.KotlinLibraryVersioning
import org.jetbrains.kotlin.library.impl.BuiltInsPlatform
import org.jetbrains.kotlin.library.impl.KlibManifestComponentWriterImpl
import org.jetbrains.kotlin.library.impl.KlibManifestComponentWriterImpl.Companion.NON_CUSTOMIZED_PROPERTY_NAMES
import org.jetbrains.kotlin.library.impl.KlibManifestComponentWriterImpl.Companion.getPropertyNameForListOfTargetNames
import org.jetbrains.kotlin.library.impl.KlibResourcesComponentWriterImpl
import org.jetbrains.kotlin.portable.source.LibraryPath as Path
import org.jetbrains.kotlin.portable.klib.ManifestProperties as Properties

''' + text[end:]
    text = replace(text, '    private var format: KlibFormat = KlibFormat.Directory\n', '')
    start = text.index('            override fun format(format: KlibFormat) {')
    end = text.index('            override fun include(', start)
    text = text[:start] + text[end:]
    text = replace(text, '    @OptIn(ExperimentalPathApi::class)\n    fun writeTo(destinationPath: Path) {',
        '    fun writeIntoMemory(destinationPath: Path, limits: MemoryKlibOutputLimits = MemoryKlibOutputLimits()): KotlinLibrary {')
    start = text.index('        when {\n            !destinationPath.exists()')
    end = text.index('\n    private fun validateManifestPropertiesAndCreateComponentWriter()', start)
    text = text[:start] + '''        val output = MemoryKlibOutput(destinationPath, limits)
        writeComponents(allComponentWriters, output)
        return output.finish()
    }

''' + text[end:]
    text = replace(text, 'private fun writeComponents(allComponentWriters: List<KlibComponentWriter>, root: Path)',
        'private fun writeComponents(allComponentWriters: List<KlibComponentWriter>, output: MemoryKlibOutput)')
    text = replace(text, 'componentWriter.writeTo(root)', 'componentWriter.writeTo(output)')
    text = replace(text, '    fun format(format: KlibFormat)\n', '')
    return replace(text, 'artifacts to the file system.', 'artifacts into a bounded logical memory directory.')


def component(text):
    text = replace(text, 'import java.nio.file.Path\n', '')
    return replace(text, 'fun writeTo(root: Path)', 'fun writeTo(output: MemoryKlibOutput)')


def ir_writer(text):
    text = path_import(text)
    text = replace(text, 'import kotlin.io.path.absolute\nimport kotlin.io.path.createDirectories\n',
        'import org.jetbrains.kotlin.library.writer.MemoryKlibOutput\n')
    text = replace(text, 'override fun writeTo(root: Path)', 'override fun writeTo(output: MemoryKlibOutput)', 2)
    text = replace(text, 'createForMainIr(root)', 'createForMainIr(output.root)')
    text = replace(text, 'createForInlinableFunctionsIr(root)', 'createForInlinableFunctionsIr(output.root)')
    text = replace(text, 'irFiles = irFiles,\n', 'irFiles = irFiles,\n                output = output,\n')
    text = replace(text, 'irFiles = inlinableFunctionsFiles,\n', 'irFiles = inlinableFunctionsFiles,\n                output = output,\n')
    text = replace(text, 'protected fun writeIrFiles(irFiles: Collection<SerializedIrFile>, layout: KlibIrComponentLayout)',
        'protected fun writeIrFiles(irFiles: Collection<SerializedIrFile>, layout: KlibIrComponentLayout, output: MemoryKlibOutput)')
    text = replace(text, 'layout.irDir.createDirectories()', 'output.createDirectories(layout.irDir)')
    for method in ['serializeNonNullableEntities', 'serializeNullableEntries']:
        import re
        text, count = re.subn(r'(' + method + r'\(SerializedIrFile::\w+, layout::\w+)(\))', r'\1, output\2', text)
        assert count == (6 if method == 'serializeNonNullableEntities' else 2)
    text = replace(text, '        destination: () -> Path,\n', '        destination: () -> Path,\n        output: MemoryKlibOutput,\n', 2)
    text = replace(text, 'IrArrayWriter(map { accessor(it) }, false).writeIntoFile(destination().absolute())',
        'output.writeBytes(destination(), IrArrayWriter(map { accessor(it) }, false).writeIntoMemory())')
    return replace(text, 'IrArrayWriter(nonNullEntries, false).writeIntoFile(destination().absolute())',
        'output.writeBytes(destination(), IrArrayWriter(nonNullEntries, false).writeIntoMemory())')


def metadata_writer(text):
    text = path_import(text)
    text = replace(text, 'import kotlin.io.path.createDirectories\nimport kotlin.io.path.writeBytes\n',
        'import org.jetbrains.kotlin.library.writer.MemoryKlibOutput\n')
    text = replace(text, 'override fun writeTo(root: Path)', 'override fun writeTo(output: MemoryKlibOutput)')
    text = replace(text, 'KlibMetadataComponentLayout(root)', 'KlibMetadataComponentLayout(output.root)')
    text = replace(text, 'layout.metadataDir.createDirectories()', 'output.createDirectories(layout.metadataDir)')
    text = replace(text, 'metadata.module?.let { layout.moduleHeaderFile.writeBytes(it) }', 'metadata.module?.let { output.writeBytes(layout.moduleHeaderFile, it) }')
    text = replace(text, 'packageFragmentDir.createDirectories()', 'output.createDirectories(packageFragmentDir)')
    text = replace(text, 'String.format("%0${padding}d", packageFragmentPartIndex)', "packageFragmentPartIndex.toString().padStart(padding, '0')")
    text = replace(text, '                layout.getPackageFragmentFile(', '                output.writeBytes(layout.getPackageFragmentFile(')
    return replace(text, '                ).writeBytes(packageFragmentPart)', '                ), packageFragmentPart)')


def manifest_writer(text):
    text = path_import(text)
    text = replace(text, 'import org.jetbrains.kotlin.io.writeProperties\n', '')
    text = replace(text, 'import java.util.Properties\n', 'import org.jetbrains.kotlin.portable.klib.ManifestProperties as Properties\n')
    text = replace(text, 'import kotlin.collections.plusAssign\nimport kotlin.io.path.createDirectories\n',
        'import org.jetbrains.kotlin.library.writer.MemoryKlibOutput\n')
    text = replace(text, 'override fun writeTo(root: Path)', 'override fun writeTo(output: MemoryKlibOutput)')
    text = replace(text, 'KlibManifestComponentLayout(root)', 'KlibManifestComponentLayout(output.root)')
    text = replace(text, '        layout.manifestFile.parent.createDirectories()\n', '')
    return replace(text, 'layout.manifestFile.writeProperties(properties)', 'output.writeProperties(layout.manifestFile, properties)')


def manifest_layout(text):
    return text[:text.index('import org.jetbrains.kotlin.io.ZipFileSystemAccessor')] + '''import org.jetbrains.kotlin.library.KlibComponentLayout
import org.jetbrains.kotlin.library.KlibConstants.KLIB_DEFAULT_COMPONENT_NAME
import org.jetbrains.kotlin.library.KlibConstants.KLIB_MANIFEST_FILE_NAME
import org.jetbrains.kotlin.portable.source.LibraryPath as Path
import org.jetbrains.kotlin.portable.source.resolve

''' + text[text.index('internal class KlibManifestComponentLayout('):]


def loaded_klibs(text):
    text = replace(text, 'import org.jetbrains.kotlin.cli.common.arguments.K2JSCompilerArguments\n', '')
    text = replace(text, 'import org.jetbrains.kotlin.cli.common.arguments.K2NativeCompilerArguments\n', '')
    return text[:text.index('/**\n * TODO (KT-61096)', text.index('class LoadedKlibs'))].rstrip() + '\n'


def resources_writer(text):
    text = path_import(text)
    text = replace(text, 'import org.jetbrains.kotlin.portable.source.LibraryPath as Path\n',
        'import org.jetbrains.kotlin.portable.source.LibraryPath as Path\nimport org.jetbrains.kotlin.portable.source.resolve\n')
    text = replace(text, 'import kotlin.io.path.createDirectories\n', 'import org.jetbrains.kotlin.library.writer.MemoryKlibOutput\n')
    text = replace(text, 'override fun writeTo(root: Path)', 'override fun writeTo(output: MemoryKlibOutput)')
    return replace(text, 'KlibResourcesComponentLayout(root).resourcesDir.createDirectories()',
        'KlibResourcesComponentLayout(output.root).resourcesDir.let(output::createDirectories)')


def special_checker(text):
    for line in ['import java.io.ByteArrayInputStream\n', 'import java.nio.file.Path\n', 'import java.util.jar.Manifest\n',
                 'import kotlin.io.path.isRegularFile\n', 'import kotlin.io.path.readBytes\n',
                 'import org.jetbrains.kotlin.backend.common.diagnostics.LibrarySpecialCompatibilityChecker.Companion.KLIB_JAR_MANIFEST_FILE\n']:
        text = replace(text, line, '')
    text = replace(text, 'import org.jetbrains.kotlin.library.*\n',
        'import org.jetbrains.kotlin.library.*\nimport org.jetbrains.kotlin.portable.linker.memoryJarImplementationVersion\n')
    start = text.index('        library.getComponent(JarManifestComponent.Kind)')
    end = text.index('\n\n    fun check(', start)
    text = text[:start] + '        Version.parseVersion(library.memoryJarImplementationVersion())' + text[end:]
    return text[:text.index('\nprivate class JarManifestComponent(')].rstrip() + '\n'


def loader_extensions(text):
    for line in ['import org.jetbrains.kotlin.io.canonicalPathString\n', 'import org.jetbrains.kotlin.library.loader.KlibLoader\n',
                 'import java.nio.file.InvalidPathException\n', 'import java.nio.file.Path\n', 'import java.nio.file.Paths\n',
                 'import kotlin.io.path.exists\n', 'import kotlin.io.path.pathString\n']:
        text = replace(text, line, '')
    text = replace(text, 'import org.jetbrains.kotlin.library.uniqueName\n',
        'import org.jetbrains.kotlin.library.uniqueName\nimport org.jetbrains.kotlin.portable.source.pathString\n')
    return text[:text.index('/**\n * A helper to load the list of libraries')].rstrip() + '\n'


TRANSFORMS = {
    JS + 'ModulesStructure.kt': lambda text: text,
    JS + 'klib.kt': js_klib,
    JS + 'lower/serialization/ir/JsIrModuleSerializer.kt': lambda text: text,
    COMMON + 'LoadedKlibs.kt': loaded_klibs,
    COMMON + 'serialization/serializeModuleIntoKlib.kt': common_serializer,
    COMMON + 'serialization/metadata/KlibSingleFileMetadataSerializer.kt': source_file,
    'compiler/fir/entrypoint/src/org/jetbrains/kotlin/fir/pipeline/Fir2KlibMetadataSerializer.kt': source_file,
    LIBRARY + 'writer/KlibWriter.kt': writer,
    LIBRARY + 'writer/KlibComponentWriter.kt': component,
    LIBRARY + 'writer/KlibWriterUtils.kt': lambda text: text,
    LIBRARY + 'impl/KlibIrComponentWriterImpl.kt': ir_writer,
    LIBRARY + 'impl/KlibMetadataComponentWriterImpl.kt': metadata_writer,
    LIBRARY + 'impl/KlibManifestComponentWriterImpl.kt': manifest_writer,
    LIBRARY + 'impl/KlibResourcesComponentWriterImpl.kt': resources_writer,
    LIBRARY + 'impl/KlibImpl.kt': manifest_layout,
    'compiler/util-klib-metadata/src/org/jetbrains/kotlin/library/metadata/KlibMetadataHeaderFlags.kt': lambda text: replace(text, 'import java.util.Properties\n', 'import org.jetbrains.kotlin.portable.klib.ManifestProperties as Properties\n'),
    COMMON + 'KlibLoaderExtensions.kt': loader_extensions,
    COMMON + 'diagnostics/LibrarySpecialCompatibilityChecker.kt': special_checker,
    JS + 'checkers/WasmLibrarySpecialCompatibilityChecker.kt': lambda text: text,
    LIBRARY + 'loader/KlibLoaderResult.kt': lambda text: text,
    LIBRARY + 'loader/KlibPlatformChecker.kt': lambda text: text,
}

REFERENCE_ONLY = [LIBRARY + 'loader/KlibLoader.kt', JS + 'loadWebKlibs.kt']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', required=True, type=Path)
    parser.add_argument('--output-root', required=True, type=Path)
    args = parser.parse_args()
    output = args.output_root.resolve()
    assert output.is_relative_to(REPOSITORY / 'out') and not output.exists()
    output.mkdir(parents=True)
    closure = json.loads((HERE.parent / 'closure.lock.json').read_text())
    assert closure['source']['commit'] == COMMIT
    proof = {record['path']: record for record in closure['files']}
    patch = []
    pins = []
    for relative, transform in TRANSFORMS.items():
        original = (args.source_root / relative).read_bytes()
        blob = hashlib.sha1(f'blob {len(original)}\0'.encode() + original).hexdigest()
        digest = hashlib.sha256(original).hexdigest()
        assert proof[relative]['gitBlob'] == blob and proof[relative]['sha256'] == digest and proof[relative]['bytes'] == len(original)
        text = original.decode()
        portable = transform(text)
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(portable)
        patch += list(difflib.unified_diff(text.splitlines(keepends=True), portable.splitlines(keepends=True), fromfile='a/' + relative, tofile='b/' + relative))
        pins.append({'path': relative, 'bytes': len(original), 'sha256': digest, 'gitBlobSha1': blob,
                     'portableBytes': len(portable.encode()), 'portableSha256': hashlib.sha256(portable.encode()).hexdigest()})
    patch = ''.join(patch).encode()
    (HERE / 'patches').mkdir(exist_ok=True)
    (HERE / 'patches/in-memory-linker.patch').write_bytes(patch)
    lock = {'schemaVersion': 1, 'source': {'repository': 'JetBrains/kotlin', 'commit': COMMIT}, 'sources': pins,
            'patch': {'path': 'patches/in-memory-linker.patch', 'bytes': len(patch), 'sha256': hashlib.sha256(patch).hexdigest()}}
    references = []
    for relative in REFERENCE_ONLY:
        original = (args.source_root / relative).read_bytes()
        digest = hashlib.sha256(original).hexdigest()
        blob = hashlib.sha1(f'blob {len(original)}\0'.encode() + original).hexdigest()
        assert proof[relative]['gitBlob'] == blob and proof[relative]['sha256'] == digest and proof[relative]['bytes'] == len(original)
        references.append({'path': relative, 'bytes': len(original), 'sha256': digest, 'gitBlobSha1': blob})
    lock['referenceOnlySources'] = references
    (HERE / 'sources.lock.json').write_text(json.dumps(lock, indent=2) + '\n')
    print(json.dumps({'sources': len(pins), 'patchSha256': lock['patch']['sha256']}))


if __name__ == '__main__':
    main()
