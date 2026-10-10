import assert from 'node:assert/strict';
import { sha256 } from '../../../scripts/source.mjs';

/** The single historical allocation-negative is an explicit contract, never omitted. */
export function compareLiteralProfile(original, portable, node, browser) {
    for (const item of [original, portable, node, browser]) assert.equal(item.records.length, 2718);
    assert.deepEqual(portable.records, original.records);
    const valid = original.records.slice(0, 2700);
    for (const item of [portable, node, browser]) {
        assert.deepEqual(item.records.slice(0, 2700), valid);
        for (let index = 2700; index < 2718; index++) if (index !== 2714) assert.equal(item.records[index], original.records[index]);
    }
    for (const item of [original, portable]) assert.equal(item.records[2714], 'malformed.7.failure=OutOfMemoryError');
    for (const item of [node, browser]) assert.equal(item.records[2714], 'malformed.7.failure=IllegalArgumentException');
    for (const item of [original, portable, node, browser]) assert.equal(item.records[2715], 'malformed.7.position=4');
    return { validObservations: 2700, exactMalformedContracts: 8, malformedCases: 9, skipped: 0,
        originalJvmEqualsCommonJvmValid: true, originalJvmEqualsNodeWasmValid: true,
        originalJvmEqualsOfflineChromiumValid: true, validRecordsSha256: sha256(Buffer.from(JSON.stringify(valid))),
        allMalformedHostCategoriesEqual: false, overflow: { originalJvm: 'OutOfMemoryError', commonJvm: 'OutOfMemoryError',
            nodeWasm: 'IllegalArgumentException', offlineChromium: 'IllegalArgumentException', position: 4, rejectedByAll: true, categoriesEqual: false } };
}
