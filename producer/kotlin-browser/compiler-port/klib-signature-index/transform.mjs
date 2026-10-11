import assert from 'node:assert/strict';

export const INDEX = 'compiler/ir/serialization.common/src/org/jetbrains/kotlin/backend/common/KlibSignatureIndexComponent.kt';
export const MEMORY = 'compiler-port-klib/MemoryKotlinLibrary.kt';
export const SIGNATURE = 'compiler/ir/ir.tree/src/org/jetbrains/kotlin/ir/util/IdSignature.kt';

export function applyExact(bytes, changes, reverse = false) {
    let text = bytes.toString();
    for (const [from, to] of reverse ? changes.slice().reverse().map(([a, b]) => [b, a]) : changes) {
        assert(from.length > 0 && text.split(from).length === 2, 'Expected one exact signature index span: ' + from.slice(0, 90));
        text = text.replace(from, to);
    }
    return Buffer.from(text);
}

// All sorting, string-table, protobuf, current/legacy ID, and array format algorithms remain intact.
export const indexChanges = [
    ['import org.jetbrains.kotlin.library.KlibLayoutReader\n', 'import org.jetbrains.kotlin.library.impl.VerifiedKlibFileSet\n'],
    ['import java.nio.file.Path\n', 'import org.jetbrains.kotlin.portable.source.LibraryPath as Path\nimport org.jetbrains.kotlin.portable.source.resolve\nimport org.jetbrains.kotlin.library.writer.MemoryKlibOutput\n'],
    ['import kotlin.io.path.createDirectories\nimport kotlin.io.path.exists\nimport kotlin.io.path.outputStream\nimport kotlin.io.path.readBytes\n', '// File access is supplied by the verified memory KLIB host.\n'],
    ['        override fun createComponentIfDataInKlibIsAvailable(layoutReader: KlibLayoutReader<KlibSignatureIndexComponentLayout>): KlibSignatureIndexComponent? =\n            if (layoutReader.readInPlaceOrFallback(false) { it.signatureIndexFile.exists() }) KlibSignatureIndexComponentImpl(layoutReader) else null',
        '        fun createComponentIfDataInKlibIsAvailable(files: VerifiedKlibFileSet): KlibSignatureIndexComponent? =\n            if (files.contains("default/indices/signatures.idx")) KlibSignatureIndexComponentImpl(files) else null'],
    ['    override fun writeTo(root: Path) {\n        val layout = KlibSignatureIndexComponentLayout(root)\n        layout.indicesDir.createDirectories()\n        layout.signatureIndexFile.outputStream().use { it.write(serializedSignatureIndex.signatureIndex) }\n    }',
        '    override fun writeTo(output: MemoryKlibOutput) {\n        val layout = KlibSignatureIndexComponentLayout(output.root)\n        output.createDirectories(layout.indicesDir)\n        output.writeBytes(layout.signatureIndexFile, serializedSignatureIndex.signatureIndex)\n    }'],
    ['${signature.javaClass.name}', '${signatureIndexTypeName(signature)}'],
    ['    private val layoutReader: KlibLayoutReader<KlibSignatureIndexComponentLayout>,', '    private val files: VerifiedKlibFileSet,'],
    ['        layoutReader.readInPlace { deserializeSignatures(it.signatureIndexFile) }', '        deserializeSignatures(files.read("default/indices/signatures.idx"))'],
    ['        private fun deserializeSignatures(signatureIndexFile: Path): Pair<Set<IdSignature>, Set<IdSignature>> {\n            val multiReader = IrMultiArrayReader(signatureIndexFile.readBytes())',
        '        private fun deserializeSignatures(signatureIndexBytes: ByteArray): Pair<Set<IdSignature>, Set<IdSignature>> {\n            val multiReader = IrMultiArrayReader { signatureIndexBytes }'],
];

export const memoryChanges = [
    ['import org.jetbrains.kotlin.library.*\n', 'import org.jetbrains.kotlin.library.*\nimport org.jetbrains.kotlin.backend.common.KlibSignatureIndexComponent\n'],
    ['    private val inlinableIr: KlibIrComponent? = MemoryIrComponent.createIfPresent(files, "ir_inlinable_functions")',
        '    private val inlinableIr: KlibIrComponent? = MemoryIrComponent.createIfPresent(files, "ir_inlinable_functions")\n    private val signatureIndex: KlibSignatureIndexComponent? by lazy {\n        KlibSignatureIndexComponent.Kind.createComponentIfDataInKlibIsAvailable(files)\n    }'],
    ['            KlibIrComponent.Kind.InlinableFunctions -> inlinableIr', '            KlibIrComponent.Kind.InlinableFunctions -> inlinableIr\n            KlibSignatureIndexComponent.Kind -> signatureIndex'],
];

export function normalizeImports(bytes, recordedPropertyImports = []) {
    assert(Array.isArray(recordedPropertyImports));
    let text = bytes.toString();
    const markers = ['\nimport kotlin.jvm.*\n', '\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n'];
    if (recordedPropertyImports.length) markers.push('\n' + recordedPropertyImports.map(name => 'import ' + name).join('\n') + '\n');
    const seen = new Set();
    for (let step = 0; step < markers.length; step++) {
        const p = /^package[^\r\n]+/m.exec(text); assert(p, 'Missing signature index package');
        const end = p.index + p[0].length, marker = markers.find(value => text.startsWith(value, end));
        if (!marker) break;
        assert(!seen.has(marker), 'Duplicate signature index assembly imports'); seen.add(marker);
        text = text.slice(0, end) + text.slice(end + marker.length);
    }
    return Buffer.from(text);
}
