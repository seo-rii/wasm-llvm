import assert from 'node:assert/strict';

export const PREFIX = 'compiler/ir/serialization.common/src/org/jetbrains/kotlin/backend/common/serialization/';
export const PATHS = ['CityHash.kt', 'FileFingerprints.kt'].map(name => PREFIX + name);
export const DISK_START = '        // File.calculateKlibHash() and List<SerializedIrFileFingerprint>.calculateKlibFingerprint()\n';
export const DISK_END = '        fun fromString(s: String): SerializedKlibFingerprint? {';
export const DISK_CONSTRUCTOR = '    constructor(klibFile: File) : this(FingerprintHash(klibFile.calculateKlibHash()))\n';
export const IMPORT = 'import org.jetbrains.kotlin.portable.text.compilerUtf8Bytes as toByteArray';
export function splitDisk(original) {
    const text = original.toString('utf8'); const start = text.indexOf(DISK_START), end = text.indexOf(DISK_END, start);
    assert(start >= 0 && end > start); assert.equal(text.split(DISK_CONSTRUCTOR).length, 2);
    return { source: text.slice(0, start) + text.slice(end).replace(DISK_CONSTRUCTOR, ''),
        declarations: [text.slice(start, end), DISK_CONSTRUCTOR] };
}
export function generateFingerprints(originals) {
    const city = originals.get(PATHS[0]).toString('utf8'); const split = splitDisk(originals.get(PATHS[1]));
    assert.equal(city.split('Character.MAX_RADIX').length, 2); assert.equal(split.source.split('Character.MAX_RADIX').length, 4);
    assert.equal(split.source.split('import java.io.File\n').length, 2); assert.equal(split.source.split('import java.nio.ByteBuffer').length, 2);
    const marker = 'package org.jetbrains.kotlin.backend.common.serialization\n';
    for (const source of [city, split.source]) assert.equal(source.split(marker).length, 2);
    return new Map([
        [PATHS[0], Buffer.from(city.replace(marker, marker + '\n' + IMPORT + '\n').replaceAll('Character.MAX_RADIX', '36'))],
        [PATHS[1], Buffer.from(split.source.replace('import java.io.File\n', '').replace('import java.nio.ByteBuffer',
            'import kotlin.jvm.JvmInline\nimport org.jetbrains.kotlin.backend.common.serialization.FingerprintByteBuffer as ByteBuffer').replaceAll('Character.MAX_RADIX', '36'))],
    ]);
}

// Conservative: every occurrence is examined, including comments and strings.
const READER = 'compiler/ir/serialization.js/src/org/jetbrains/kotlin/ir/backend/js/klib.kt';
const ALLOWED = [
    'val KotlinLibrary.serializedKlibFingerprint: SerializedKlibFingerprint?',
    'get() = manifestProperties.getProperty(KLIB_PROPERTY_SERIALIZED_KLIB_FINGERPRINT)?.let { SerializedKlibFingerprint.fromString(it) }',
    'p.setProperty(KLIB_PROPERTY_SERIALIZED_KLIB_FINGERPRINT, SerializedKlibFingerprint(fingerprints).klibFingerprint.toString())',
];
export function guardDiskReaders(inventory) {
    assert(inventory.length > 0, 'Retained source inventory is required'); const readers = []; let fingerprintSeen = false;
    for (const item of inventory) {
        let source = item.source.toString('utf8');
        if (item.path.endsWith(PATHS[1])) { fingerprintSeen = true; source = splitDisk(item.source).source; continue; }
        const lines = source.split('\n');
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index].trim();
            if (!/\b(?:SerializedKlibFingerprint|calculateKlibHash)\b/.test(line)) continue;
            if (/^import org\.jetbrains\.kotlin\.backend\.common\.serialization\.SerializedKlibFingerprint$/.test(line)) continue;
            assert(item.path.endsWith(READER) && ALLOWED.includes(line), 'Retained disk fingerprint API may be read: ' + item.path + ':' + (index + 1));
            readers.push({ path: item.path, line: index + 1, statement: line });
        }
    }
    assert(fingerprintSeen, 'Original FileFingerprints must appear in the retained graph');
    assert.equal(readers.length, 3, 'Expected actual serialization manifest reader');
    assert.deepEqual(readers.map(item => item.statement), ALLOWED);
    return { policy: 'reject every unknown reference, alias import or disk API token', readers, diskReaders: [], algorithmExclusions: [] };
}
