import assert from 'node:assert/strict';
import { sha256 } from '../../scripts/source.mjs';

export const PROVIDER = 'compiler/fir/providers/src/org/jetbrains/kotlin/fir/resolve/ContainingClassUtils.kt';
export const RESOLVE = 'compiler/fir/resolve/src/org/jetbrains/kotlin/fir/resolve/ResolveUtils.kt';
export const DECLARATION = 'fun FirCallableDeclaration.getContainingClass(): FirRegularClass? =\n    this.containingClassLookupTag()?.let { lookupTag ->\n        lookupTag.toRegularClassSymbol(moduleData.session)?.fir\n    }';

export function deduplicateContainingClass(originals, lock) {
    for (const logical of [PROVIDER, RESOLVE]) {
        const bytes = originals.get(logical), pin = lock.sources.find(item => item.path === logical); assert(bytes && pin);
        assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
        assert.equal(bytes.toString().split(DECLARATION).length, 2, 'One exact declaration per original source');
    }
    assert.equal(Buffer.byteLength(DECLARATION), lock.declaration.bytes); assert.equal(sha256(Buffer.from(DECLARATION)), lock.declaration.sha256);
    const before = originals.get(RESOLVE).toString(), offset = Buffer.byteLength(before.slice(0, before.indexOf(DECLARATION)));
    const bytes = Buffer.from(before.replace(DECLARATION, ''));
    if (lock.output) { assert.equal(bytes.length, lock.output.bytes); assert.equal(sha256(bytes), lock.output.sha256); }
    return { bytes, removedSpan: { offset, bytes: Buffer.byteLength(DECLARATION), sha256: sha256(Buffer.from(DECLARATION)) },
        retainedDeclaration: { path: PROVIDER, bytes: Buffer.byteLength(DECLARATION), sha256: sha256(Buffer.from(DECLARATION)) } };
}
