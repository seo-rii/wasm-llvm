import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readRegular } from '../../../scripts/source.mjs';
import { compareRawText, defaultReferenceCache, verifyNumberSources } from './build-probe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../../..');

test('original JDK/consumer/helper/license bytes match every source pin', async () => {
    const input = await verifyNumberSources();
    assert.equal(input.lock.references.length, 3);
    assert.equal(input.lock.consumerOriginals.length, 2);
    assert(input.ported.toString().includes('Copyright (c) 2013, 2020, Oracle'));
    assert(input.ported.toString().includes('Modified 2026-10-10'));
});

test('a changed reference fails before any compiler execution', async () => {
    const parent = path.join(repository, 'out/kotlin-js-ast-number-integrity'); await mkdir(parent, { recursive: true });
    const referenceCache = await mkdtemp(path.join(parent, 'run-'));
    for (const name of ['FloatingDecimal.java', 'FDBigInteger.java', 'Double.java']) {
        const bytes = await readRegular(path.join(defaultReferenceCache, name));
        await writeFile(path.join(referenceCache, name), name === 'FloatingDecimal.java' ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes);
    }
    await assert.rejects(verifyNumberSources({ referenceCache }), /Pinned source/);
});

test('raw comparison rejects the native Wasm 1e23 spelling and does no normalization', () => {
    compareRawText('44b52d02c7e14af6:9.999999999999999E22\n', '44b52d02c7e14af6:9.999999999999999E22\n', 'same');
    assert.throws(() => compareRawText('44b52d02c7e14af6:9.999999999999999E22\n', '44b52d02c7e14af6:1.0E23\n', '1e23'), /raw text differs/);
    assert.throws(() => compareRawText('8000000000000000:-0.0\n', '8000000000000000:0.0\n', 'negative zero'), /raw text differs/);
});
