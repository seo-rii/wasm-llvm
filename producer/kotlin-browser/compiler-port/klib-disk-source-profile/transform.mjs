import assert from 'node:assert/strict';
import { lexicalReferenceView, nativeOutputReferences } from '../native-js-output-profile/references.mjs';

export const CONFIG = 'compiler/config/gen/org/jetbrains/kotlin/config/KlibConfigurationKeys.kt';
export const TARGETS = [
    'compiler/util-io/src/org/jetbrains/kotlin/io/ZipFileSystemUtils.kt',
    'compiler/util-io/src/org/jetbrains/kotlin/io/ZipFileSystemAccessor.kt',
    'compiler/util-klib/src/org/jetbrains/kotlin/library/KlibLayoutReader.kt',
    'compiler/util-klib/src/org/jetbrains/kotlin/library/KlibFormat.kt',
    'compiler/util-klib/src/org/jetbrains/kotlin/library/KlibSizeInfo.kt',
    'compiler/util-klib/src/org/jetbrains/kotlin/library/impl/KlibMetadataComponentImpl.kt',
    'compiler/ir/serialization.common/src/org/jetbrains/kotlin/backend/common/loadMetadataKlibs.kt',
];
export const DECLARATIONS = [
    ...['withZipFileSystem', 'zipDirAs', 'unzipTo', 'zipDirAsInternal', 'zipFileSystem'].map(name => ({ packageName: 'org.jetbrains.kotlin.io', name, kind: 'function' })),
    ...[['ZipFileSystemAccessor', 'interface'], ['ZipFileSystemInPlaceAccessor', 'object'], ['ZipFileSystemCacheableAccessor', 'class']].map(([name, kind]) => ({ packageName: 'org.jetbrains.kotlin.io', name, kind })),
    ...[['KlibLayoutReader', 'class'], ['KlibLayoutReaderFactory', 'class'], ['KlibFormat', 'interface'], ['KlibElementWithSize', 'class'], ['loadSizeInfo', 'function']].map(([name, kind]) => ({ packageName: 'org.jetbrains.kotlin.library', name, kind })),
    { packageName: 'org.jetbrains.kotlin.library.impl', name: 'KlibMetadataComponentImpl', kind: 'class' },
    { packageName: 'org.jetbrains.kotlin.backend.common', name: 'loadMetadataKlibs', kind: 'function' },
    { packageName: 'org.jetbrains.kotlin.config', name: 'ZIP_FILE_SYSTEM_ACCESSOR', kind: 'val' },
    { packageName: 'org.jetbrains.kotlin.config', name: 'zipFileSystemAccessor', kind: 'var' },
];
export const CONFIG_CHANGES = [
    ['import org.jetbrains.kotlin.io.ZipFileSystemAccessor\n', '// Disk access is outside the verified memory library profile.\n'],
    ['    // Zip file system accessor, used for klib reading.\n    @JvmField\n    val ZIP_FILE_SYSTEM_ACCESSOR = CompilerConfigurationKey.create<ZipFileSystemAccessor>("ZIP_FILE_SYSTEM_ACCESSOR")\n',
        '    // Disk-access configuration is outside the verified memory library profile.\n'],
    ['var CompilerConfiguration.zipFileSystemAccessor: ZipFileSystemAccessor?\n    get() = get(KlibConfigurationKeys.ZIP_FILE_SYSTEM_ACCESSOR)\n    set(value) { put(KlibConfigurationKeys.ZIP_FILE_SYSTEM_ACCESSOR, requireNotNull(value) { "nullable values are not allowed" }) }\n',
        '// The disk-access property is outside the verified memory library profile.\n'],
];
export function transformConfiguration(bytes, reverse = false) {
    let text = bytes.toString();
    for (const [before, after] of reverse ? CONFIG_CHANGES.slice().reverse().map(([a, b]) => [b, a]) : CONFIG_CHANGES) {
        assert.equal(text.split(before).length, 2, 'Expected one exact disk configuration span'); text = text.replace(before, after);
    }
    return Buffer.from(text);
}
// Conservative lexical and literal spellings; arbitrary runtime string construction is not a claimed call graph.
export function diskReferences(text) {
    const decoded = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    const view = lexicalReferenceView(decoded), joined = view.replace(/[^A-Za-z0-9_]/g, ''), result = [];
    for (const declaration of DECLARATIONS) {
        const reasons = nativeOutputReferences(decoded, declaration, view);
        if (decoded.includes(declaration.name)) reasons.push('literal or identifier');
        else if (joined.includes(declaration.name)) reasons.push('conservatively joined name');
        if (reasons.length) result.push({ name: declaration.name, reasons: [...new Set(reasons)] });
    }
    return result;
}
