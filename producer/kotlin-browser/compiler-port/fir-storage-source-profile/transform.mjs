import assert from 'node:assert/strict';
import { sha256 } from '../../scripts/source.mjs';

export const STORAGE = 'compiler/fir/fir2ir/src/org/jetbrains/kotlin/fir/backend/Fir2IrDeclarationStorage.kt';
export const CONFIG = 'compiler/fir/fir2ir/src/org/jetbrains/kotlin/fir/backend/Fir2IrConfiguration.kt';
export const UTILS = 'compiler/fir/tree/src/org/jetbrains/kotlin/fir/Utils.kt';
export const HOST = 'compiler/frontend.common/src/org/jetbrains/kotlin/KtSourceElement.kt';
export const ELEMENT = 'compiler/fir/tree/gen/org/jetbrains/kotlin/fir/FirElement.kt';

export function profileStorage(predecessor, lock) {
    assert.equal(predecessor.length, lock.predecessors.storage.bytes, 'Storage predecessor size');
    assert.equal(sha256(predecessor), lock.predecessors.storage.sha256, 'Storage predecessor hash');
    let text = predecessor.toString(); const exclusions = [];
    for (const span of lock.exclusions) {
        assert.equal(Buffer.byteLength(span.text), span.bytes); assert.equal(sha256(Buffer.from(span.text)), span.sha256);
        assert.equal(text.split(span.text).length, 2, 'One exact pinned exclusion required');
        exclusions.push({ kind: span.kind, offset: Buffer.byteLength(text.slice(0, text.indexOf(span.text))), bytes: span.bytes, sha256: span.sha256 });
        text = text.replace(span.text, '');
    }
    assert(!/\b(?:NonCachedSourceFacadeContainerSource|JvmFileClassUtil|FacadeClassSource|JvmClassName|KtFile)\b/.test(text));
    const bytes = Buffer.from(text);
    if (lock.output) { assert.equal(bytes.length, lock.output.bytes); assert.equal(sha256(bytes), lock.output.sha256); }
    return { bytes, exclusions };
}
