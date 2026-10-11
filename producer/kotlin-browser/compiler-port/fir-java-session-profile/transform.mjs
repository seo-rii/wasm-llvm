import assert from 'node:assert/strict';
import { sha256 } from '../../scripts/source.mjs';

export const TARGET = 'compiler/fir/entrypoint/src/org/jetbrains/kotlin/fir/session/ComponentsContainers.kt';
export const SYMBOLS = ['FirSharableJavaComponents', 'registerJavaComponents'];
export const REQUIRED = [
    'compiler/fir/entrypoint/src/org/jetbrains/kotlin/fir/session/FirWasmSessionFactory.kt',
    'compiler/fir/entrypoint/src/org/jetbrains/kotlin/fir/session/FirAbstractSessionFactory.kt',
    'compiler-port-entry/BrowserCompiler.kt',
];

export function profileJavaSession(source, lock) {
    assert.equal(source.length, lock.target.bytes, 'Original session source size changed');
    assert.equal(sha256(source), lock.target.sha256, 'Original session source hash changed');
    const chunks = []; let end = 0;
    for (const span of lock.exclusions) {
        const bytes = Buffer.from(span.text);
        assert.equal(bytes.length, span.bytes); assert.equal(sha256(bytes), span.sha256);
        assert(span.offset >= end, 'Overlapping Java session exclusions');
        assert.equal(source.indexOf(bytes), span.offset, 'Java session span changed');
        assert.equal(source.indexOf(bytes, span.offset + 1), -1, 'Ambiguous Java session span');
        chunks.push(source.subarray(end, span.offset)); end = span.offset + bytes.length;
    }
    chunks.push(source.subarray(end)); const output = Buffer.concat(chunks);
    assert.equal(output.length, lock.output.bytes); assert.equal(sha256(output), lock.output.sha256);
    return output;
}

export function normalizeSessionImports(bytes, canonical, recordedPropertyImports = []) {
    let text = bytes.toString();
    assert(Array.isArray(recordedPropertyImports) && new Set(recordedPropertyImports).size === recordedPropertyImports.length);
    const existing = new Set([...canonical.toString().matchAll(/^import ([^\r\n]+)$/gm)].map(match => match[1]));
    const additions = recordedPropertyImports.filter(name => !existing.has(name));
    const markers = ['\nimport kotlin.jvm.*\n', '\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n'];
    if (additions.length) markers.push('\n' + additions.map(name => 'import ' + name).join('\n') + '\n');
    const seen = new Set();
    for (let step = 0; step < markers.length; step++) {
        const declaration = /^package[^\r\n]+/m.exec(text); assert(declaration);
        const end = declaration.index + declaration[0].length;
        const marker = markers.find(value => text.startsWith(value, end)); if (!marker) break;
        assert(!seen.has(marker), 'Duplicated recorded session import block'); seen.add(marker);
        text = text.slice(0, end) + text.slice(end + marker.length);
    }
    return Buffer.from(text);
}
