#!/usr/bin/env python3
"""Regenerate the reviewed host patch from verified upstream bytes into an isolated out/ directory."""
import argparse
import difflib
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parents[3]
PREFIX = 'compiler/util-klib/src/org/jetbrains/kotlin/library/'
SOURCE_COMMIT = '4d78aae1e337cd40f69baa865aed950fe807a775'


def replace(text, before, after, occurrences=1):
    assert text.count(before) == occurrences, (before[:100], text.count(before))
    return text.replace(before, after)


def remove_file_readers(text):
    import re
    text = replace(text, 'import org.jetbrains.kotlin.library.KlibComponentLayout\n', '')
    text = replace(text, 'import org.jetbrains.kotlin.library.KlibLayoutReader\n', '')
    text = replace(text, 'import java.nio.ByteBuffer\n', 'import org.jetbrains.kotlin.portable.klib.PortableByteCursor as ByteBuffer\n')
    text = replace(text, 'import java.nio.file.Path\n', '')
    text = replace(text, 'import kotlin.io.path.readBytes\n', '')
    text, count = re.subn(r'/\*\* On-demand read from a file \(potentially inside a KLIB archive file\)\. \*/\ninline fun <KCL : KlibComponentLayout> [\s\S]*?\n\): [^\n]*\n\n', '', text)
    assert count == 3
    text = replace(text, 'private fun ByteBuffer.readIndexToOffset(position: Int): IndexToOffset {',
        'private fun ByteBuffer.readIndexToOffset(position: Int, endPosition: Int = limit()): IndexToOffset {')
    text = replace(text, '    var count = this.int\n', '    var count = this.readInt(endPosition)\n    require(count != Int.MIN_VALUE) { "Invalid KLIB table count" }\n')
    text = replace(text, '    val elementSizes = IntArray(count) {\n        if (usesVarInt) readUnsignedLeb128(this::get).toInt() else this.int\n    }',
        '    checkTableCount(count, if (usesVarInt) 1 else 4, endPosition)\n' +
        '    val elementSizes = IntArray(count) {\n' +
        '        val size = if (usesVarInt) readUnsignedLeb128({ readByte(endPosition) }).toLong() else readInt(endPosition).toLong()\n' +
        '        require(size in 0..Int.MAX_VALUE.toLong()) { "Invalid KLIB element size" }\n' +
        '        size.toInt()\n    }')
    text = replace(text, '        indexToOffset[i + 1] = indexToOffset[i] + elementSizes[i]\n',
        '        val nextOffset = indexToOffset[i].toLong() + elementSizes[i]\n' +
        '        require(nextOffset <= endPosition.toLong() - position) { "KLIB table exceeds its byte range" }\n' +
        '        indexToOffset[i + 1] = nextOffset.toInt()\n')
    text = replace(text, 'private fun ByteBuffer.readDeclarationIdToCoordinates(position: Int): DeclarationIdToCoordinates {',
        'private fun ByteBuffer.readDeclarationIdToCoordinates(position: Int, endPosition: Int = limit()): DeclarationIdToCoordinates {')
    text = replace(text, '    val count = this.int\n    val declarationIdToCoordinates',
        '    val count = this.readInt(endPosition)\n' +
        '    checkTableCount(count, 12, endPosition)\n' +
        '    val headerSize = 4 + count * 12\n' +
        '    val declarationIdToCoordinates')
    text = replace(text, '        val declarationId = DeclarationId(this.int)\n        val offset = this.int\n        val size = this.int\n',
        '        val declarationId = DeclarationId(this.readInt(endPosition))\n' +
        '        val offset = this.readInt(endPosition)\n' +
        '        val size = this.readInt(endPosition)\n' +
        '        require(offset >= headerSize) { "KLIB declaration overlaps its table index" }\n' +
        '        checkRange(position, offset, endPosition)\n' +
        '        checkRange(position + offset, size, endPosition)\n')
    text = replace(text, '): IndexToOffset = indexToIndexToOffset.getOrPut(rowIndex) { readIndexToOffset(indexToOffset[rowIndex]) }',
        '): IndexToOffset = indexToIndexToOffset.getOrPut(rowIndex) { readIndexToOffset(indexToOffset[rowIndex], indexToOffset[rowIndex + 1]) }')
    text = replace(text, '        readDeclarationIdToCoordinates(rowOffset)\n',
        '        readDeclarationIdToCoordinates(rowOffset, indexToOffset[rowIndex + 1])\n')
    text = replace(text, '    val result = ByteArray(size)\n    this.position(offset)', '    checkRange(offset, size)\n    val result = ByteArray(size)\n    this.position(offset)')
    return text


def writer(text):
    text = replace(text, 'import java.io.ByteArrayOutputStream\nimport java.io.DataOutput\nimport java.io.DataOutputStream\nimport java.nio.file.Path\nimport kotlin.io.path.outputStream\n',
        'import org.jetbrains.kotlin.portable.klib.PortableDataOutput as DataOutput\nimport org.jetbrains.kotlin.portable.klib.KlibByteLimits\n')
    start = text.index('    fun writeIntoFile(')
    end = text.index('\n}\n', start)
    text = (text[:start] + '    fun writeIntoMemory(maximumBytes: Int = KlibByteLimits.MAX_BUFFER_BYTES): ByteArray {\n' +
        '        val output = DataOutput(maximumBytes)\n        writeData(output)\n        return output.toByteArray()\n    }' + text[end:])
    for class_name, variable, unit in [('IrArrayWriter', 'data', 'it.size.toLong()'),
                                      ('IrStringWriter', 'data', 'it.length.toLong() * 3'),
                                      ('IrDeclarationWriter', 'declarations', 'it.size.toLong()')]:
        line_start = text.index('class ' + class_name)
        position = text.index('    override fun writeData', line_start)
        overhead = 12 if class_name == 'IrDeclarationWriter' else 5
        text = text[:position] + f'    init {{\n        require({variable}.size <= KlibByteLimits.MAX_TABLE_ENTRIES) {{ "Excessive KLIB table count" }}\n' + \
            f'        require(4L + {overhead}L * {variable}.size + {variable}.sumOf {{ {unit} }} <= KlibByteLimits.MAX_BUFFER_BYTES) {{ "KLIB writer input exceeds the byte limit" }}\n    }}\n\n' + text[position:]
    return text


def provider(text):
    text = replace(text, 'import java.lang.ref.SoftReference\nimport java.nio.ByteBuffer\n',
        'import org.jetbrains.kotlin.portable.klib.PortableByteCursor as ByteBuffer\n')
    doc_start = text.index('    /**\n     * Allows reading data from the byte array that is obtained though')
    doc_end = text.index('    class OnDemandMemoryBuffer', doc_start)
    text = text[:doc_start] + '    /** Request-local immutable cache; no JVM SoftReference or global retention. */\n' + text[doc_end:]
    text = replace(text, 'private var cachedBuffer: SoftReference<ByteBuffer?> = SoftReference(null)', 'private var cachedBuffer: ByteBuffer? = null')
    text = replace(text, 'var buffer = cachedBuffer.get()', 'var buffer = cachedBuffer')
    text = replace(text, 'cachedBuffer = SoftReference(buffer)', 'cachedBuffer = buffer')
    return text


def kcomponent(text):
    text = replace(text, 'import java.nio.file.Path\n', 'import org.jetbrains.kotlin.portable.source.LibraryPath as Path\n')
    text = replace(text, ' * the corresponding data presence check are performed in the [KlibComponent.Kind.createComponentIfDataInKlibIsAvailable].',
        ' * the corresponding data presence check are performed by the approved in-memory library host.')
    start = text.index('        /**\n         * Create an instance of the component.')
    end = text.index('\n    }', start)
    return text[:start] + text[end:]


def ir_component(text):
    text = replace(text, 'import org.jetbrains.kotlin.library.KlibLayoutReader\n', '')
    text = replace(text, 'import org.jetbrains.kotlin.library.impl.KlibIrComponentImpl\nimport java.nio.file.Path\nimport kotlin.io.path.exists\n',
        'import org.jetbrains.kotlin.portable.source.LibraryPath as Path\nimport org.jetbrains.kotlin.portable.source.resolve\n')
    start = text.index('\n        override fun createComponentIfDataInKlibIsAvailable(')
    end = text.index('\n    }', start)
    return text[:start] + text[end:]


def metadata_component(text):
    text = replace(text, 'import org.jetbrains.kotlin.library.KlibLayoutReader\n', '')
    text = replace(text, 'import org.jetbrains.kotlin.library.impl.KlibMetadataComponentImpl\nimport org.jetbrains.kotlin.library.metadata.KlibMetadataProtoBuf\nimport org.jetbrains.kotlin.metadata.ProtoBuf\nimport java.nio.file.Path\n',
        'import org.jetbrains.kotlin.portable.source.LibraryPath as Path\nimport org.jetbrains.kotlin.portable.source.resolve\n')
    text = replace(text, '[KlibMetadataProtoBuf.Header]', '`KlibMetadataProtoBuf.Header`')
    text = replace(text, '[ProtoBuf.PackageFragment]', '`ProtoBuf.PackageFragment`')
    start = text.index('\n        /**\n         * Note: It is expected that every correct Klib has metadata files.')
    end = text.index('\n    }', start)
    return text[:start] + text[end:]


def ir_impl(text):
    for line in ['import org.jetbrains.kotlin.library.KlibLayoutReader\n', 'import org.jetbrains.kotlin.library.components.KlibIrComponentLayout\n', 'import kotlin.io.path.exists\n']:
        text = replace(text, line, '')
    return text[:text.index('\n/**\n * The default implementation of [KlibIrComponent].')].rstrip() + '\n'


def properties_util(text):
    start = text.index('import org.jetbrains.kotlin.util.parseSpaceSeparatedArgs')
    end = text.index('/**\n * TODO: this method working with suffixes')
    portable = text[:start] + 'import org.jetbrains.kotlin.util.parseSpaceSeparatedArgs\nimport org.jetbrains.kotlin.portable.klib.ManifestProperties as Properties\n\n' + text[end:]
    return replace(portable, 'val (property, rest) = ', 'val [property, rest] = ')


def manifest_type(text):
    if 'import java.util.*\n' in text:
        return replace(text, 'import java.util.*\n', 'import org.jetbrains.kotlin.portable.klib.ManifestProperties as Properties\n')
    return replace(text, 'import java.util.Properties\n', 'import org.jetbrains.kotlin.portable.klib.ManifestProperties as Properties\n')


def wobbly_tf8(text):
    text = replace(text, 'package org.jetbrains.kotlin.library.encodings\n',
        'package org.jetbrains.kotlin.library.encodings\n\nimport org.jetbrains.kotlin.portable.klib.PortableCharacter as Character\n')
    return replace(text, 'return if (buffer.size == charsWritten) String(buffer) else String(buffer, 0, charsWritten)',
        'return if (buffer.size == charsWritten) buffer.concatToString() else buffer.concatToString(0, charsWritten)')


TRANSFORMS = {
    PREFIX + 'impl/lowLevelReaders.kt': remove_file_readers,
    PREFIX + 'impl/lowLevelWriters.kt': writer,
    PREFIX + 'impl/ReadByteBufferProvider.kt': provider,
    PREFIX + 'encodings/WobblyTF8.kt': wobbly_tf8,
    PREFIX + 'Klib.kt': kcomponent,
    PREFIX + 'components/KlibIrComponent.kt': ir_component,
    PREFIX + 'components/KlibMetadataComponent.kt': metadata_component,
    PREFIX + 'impl/KlibIrComponentImpl.kt': ir_impl,
    PREFIX + 'KotlinLibrary.kt': manifest_type,
    PREFIX + 'KotlinLibraryVersioning.kt': manifest_type,
    PREFIX + 'KlibAttributes.kt': lambda t: t,
    PREFIX + 'KlibConstants.kt': lambda t: t,
    PREFIX + 'KotlinAbiVersion.kt': lambda t: t,
    PREFIX + 'KotlinIrSignatureVersion.kt': lambda t: t,
    PREFIX + 'SerializedDataStructures.kt': lambda t: t,
    PREFIX + 'impl/BuiltInsPlatform.kt': lambda t: t,
    'compiler/util-io/src/org/jetbrains/kotlin/io/PropertyFileUtils.kt': properties_util,
    'compiler/util-io/src/org/jetbrains/kotlin/util/Util.kt': lambda t: t[:t.index('import java.nio.file.Path')] + t[t.index('fun parseSpaceSeparatedArgs('):],
    'compiler/util-io/src/org/jetbrains/kotlin/util/Leb128.kt': lambda t: replace(t, 'import java.io.InputStream\nimport java.io.OutputStream\n', ''),
    'core/metadata/src/org/jetbrains/kotlin/metadata/deserialization/BinaryVersion.kt': lambda t: replace(replace(t, 'this::class.java == other::class.java', 'this::class == other::class'), '        @JvmStatic\n', ''),
    'core/metadata/src/org/jetbrains/kotlin/metadata/deserialization/MetadataVersion.kt': lambda t: replace(t, '        @JvmField\n', '', 3),
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', required=True, type=Path)
    parser.add_argument('--output-root', required=True, type=Path)
    args = parser.parse_args()
    output = args.output_root.resolve()
    assert output.is_relative_to(REPOSITORY / 'out') and not output.exists()
    output.mkdir(parents=True)
    patch = []
    pins = []
    closure = json.loads((HERE.parent / 'closure.lock.json').read_text())
    assert closure['source']['commit'] == SOURCE_COMMIT
    proven = {entry['path']: entry for entry in closure['files']}
    def read_verified(relative):
        raw = (args.source_root / relative).read_bytes()
        proof = proven[relative]
        assert len(raw) == proof['bytes'] and hashlib.sha256(raw).hexdigest() == proof['sha256'], relative
        assert hashlib.sha1(f'blob {len(raw)}\0'.encode() + raw).hexdigest() == proof['gitBlob'], relative
        return raw
    for relative, transform in TRANSFORMS.items():
        raw = read_verified(relative)
        original = raw.decode('utf-8')
        portable = transform(original)
        final = portable.encode('utf-8')
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(final)
        patch += list(difflib.unified_diff(original.splitlines(keepends=True), portable.splitlines(keepends=True), fromfile='a/' + relative, tofile='b/' + relative))
        pins.append({'path': relative, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                     'gitBlobSha1': hashlib.sha1(f'blob {len(raw)}\0'.encode() + raw).hexdigest(),
                     'portableBytes': len(final), 'portableSha256': hashlib.sha256(final).hexdigest()})
    patch_bytes = ''.join(patch).encode()
    (HERE / 'patches').mkdir(exist_ok=True)
    (HERE / 'patches' / 'in-memory-klib.patch').write_bytes(patch_bytes)
    references = []
    for relative in [PREFIX + 'impl/KlibMetadataComponentImpl.kt', PREFIX + 'KlibLayoutReader.kt', PREFIX + 'KlibFormat.kt']:
        raw = read_verified(relative)
        references.append({'path': relative, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                           'gitBlobSha1': hashlib.sha1(f'blob {len(raw)}\0'.encode() + raw).hexdigest()})
    lock = {'schemaVersion': 1, 'source': {'repository': 'JetBrains/kotlin', 'commit': SOURCE_COMMIT},
            'patch': {'path': 'patches/in-memory-klib.patch', 'bytes': len(patch_bytes), 'sha256': hashlib.sha256(patch_bytes).hexdigest()}, 'sources': pins,
            'referenceOnlySources': references}
    (HERE / 'sources.lock.json').write_text(json.dumps(lock, indent=2) + '\n')
    print(json.dumps({'sources': len(pins), 'patchSha256': lock['patch']['sha256'], 'generatedRoot': str(output)}))


if __name__ == '__main__':
    main()
