import assert from 'node:assert/strict';
import { sha256 } from '../../scripts/source.mjs';

export const CONE_PATH = 'compiler/fir/cones/src/org/jetbrains/kotlin/fir/types/ConeTypes.kt';
export const FINAL_CLASSES = ['ConeCapturedType', 'ConeIntersectionType', 'ConeUnionType'];

export function transformConeClassIdentity(bytes, lock) {
    assert(Buffer.isBuffer(bytes));
    assert.equal(bytes.length, lock.predecessor.bytes, 'Identity predecessor size changed');
    assert.equal(sha256(bytes), lock.predecessor.sha256, 'Identity predecessor content changed');
    let text = bytes.toString(); const changes = [];
    for (const pin of lock.boundaries) {
        assert(FINAL_CLASSES.includes(pin.className));
        const declaration = new RegExp('^(?:(data) )?class ' + pin.className + '\\b', 'gm');
        const declarations = [...text.matchAll(declaration)];
        assert.equal(declarations.length, 1, 'Pinned concrete class must remain final: ' + pin.className);
        assert.equal(declarations[0][0], pin.declaration);
        const before = '        if (javaClass != other?.javaClass) return false\n\n        other as ' + pin.className;
        const after = '        if (other !is ' + pin.className + ') return false\n\n        other as ' + pin.className;
        assert.equal(text.split(before).length, 2, 'Expected exactly one original equality guard: ' + pin.className);
        const start = text.indexOf(before), oldBytes = Buffer.from(before), newBytes = Buffer.from(after);
        assert.equal(sha256(oldBytes), pin.guardSha256);
        changes.push({ className: pin.className, start: Buffer.byteLength(text.slice(0, start)),
            beforeBytes: oldBytes.length, beforeSha256: sha256(oldBytes), afterBytes: newBytes.length, afterSha256: sha256(newBytes) });
        text = text.replace(before, after);
    }
    assert.equal(changes.length, 3);
    let restored = text;
    for (const name of FINAL_CLASSES) restored = restored.replace('        if (other !is ' + name + ') return false\n\n        other as ' + name,
        '        if (javaClass != other?.javaClass) return false\n\n        other as ' + name);
    assert.equal(restored, bytes.toString(), 'Every byte outside the three guarded spans must remain unchanged');
    const output = Buffer.from(text);
    assert.equal(output.length, lock.output.bytes); assert.equal(sha256(output), lock.output.sha256);
    return { bytes: output, changes };
}

/** Probe-only exact method projections. Payload layouts are explicitly fixtures, never shipping compiler types. */
export function projectConeMethods(bytes, lock, variant) {
    assert(['original', 'common'].includes(variant));
    const text = bytes.toString();
    const layouts = {
        ConeCapturedType: '(val isMarkedNullable: Boolean = false, val constructor: IdentityPayload, val attributes: Any? = null)',
        ConeIntersectionType: '(val intersectedTypes: Collection<ValuePayload>, val upperBoundForApproximation: ValuePayload? = null)',
        ConeUnionType: '(val primaryType: ValuePayload, val richErrorTypes: List<ValuePayload>, val attributes: Any? = null)',
    };
    const methods = [];
    for (const pin of lock.boundaries) {
        const declaration = text.indexOf(pin.declaration), next = text.indexOf('\n}', declaration);
        assert(declaration >= 0 && next > declaration);
        const start = text.indexOf('    override fun equals(other: Any?): Boolean {', declaration);
        assert(start > declaration && start < next);
        let body = text.slice(start, next);
        const expected = variant === 'original' ? pin.originalMethodsSha256 : pin.commonMethodsSha256;
        assert.equal(sha256(Buffer.from(body)), expected, 'Actual equality/hash method projection changed');
        methods.push({ className: pin.className, start: Buffer.byteLength(text.slice(0, start)), bytes: Buffer.byteLength(body), sha256: expected });
        const cache = pin.className === 'ConeIntersectionType' ? '    private var hashCode = 0\n\n' : '';
        if (cache) assert(text.slice(declaration, start).includes(cache.trimEnd()), 'Original hash cache changed');
        layouts[pin.className] = 'class ' + pin.className + layouts[pin.className] + ' {\n' + cache + body + '\n}\n';
    }
    const notice = text.slice(0, text.indexOf('\npackage '));
    const code = notice + '\n// Probe-only method boundary projection with explicit payload fixtures.\n' +
        'package org.jetbrains.kotlin.portable.coneclassidentity.boundary\n\n' + FINAL_CLASSES.map(name => layouts[name]).join('\n');
    return { bytes: Buffer.from(code), methods, shippingSource: false, fullConeTypeGraph: false };
}
