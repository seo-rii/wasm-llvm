import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, writeJson } from '../../scripts/source.mjs';
import { prepareKlibSources } from '../klib/prepare.mjs';
import { prepareKlibSignatureIndex, verifyKlibSignatureIndex, verifyFinalKlibSignatureIndex } from './prepare.mjs';
import { INDEX, MEMORY, applyExact, indexChanges, memoryChanges, normalizeImports } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const pin = async (logical, filename) => { const bytes = await readFile(filename); return { path: logical, filename, bytes: bytes.length, sha256: sha256(bytes) }; };

test('public preparation, replay, and final owner/body guards', async t => {
    const outputRoot = await mkdtemp(path.join(REPO, 'out/kotlin-klib-signature-guards-'));
    const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
    const klibComponent = await prepareKlibSources({ sourceRoot, outputRoot: path.join(outputRoot, 'klib') });
    const memory = klibComponent.commonSources.find(file => file.endsWith('/' + MEMORY));
    const retainedSources = [await pin(INDEX, path.join(sourceRoot, INDEX)), await pin(MEMORY, memory)];
    const options = { sourceRoot, outputRoot: path.join(outputRoot, 'index'), klibComponent, retainedSources };
    const prepared = await prepareKlibSignatureIndex(options);
    assert.deepEqual(await verifyKlibSignatureIndex(prepared.outputRoot), prepared.receipt);
    let selected = await Promise.all(prepared.commonSources.map(file => pin(path.relative(prepared.outputRoot, file), file)));
    const final = overrides => verifyFinalKlibSignatureIndex({ outputRoot: prepared.outputRoot, retainedSources: selected, ...overrides });
    const positive = await final(); assert.equal(positive.receipt.checked.length, 3);
    assert.deepEqual(positive.predecessorRetainedSources.find(row => row.path === MEMORY), retainedSources[1]);
    const checks = [];
    async function negative(name, task) { await task(); checks.push(name); }
    await negative('wrong predecessor receipt object', async () => {
        await assert.rejects(prepareKlibSignatureIndex({ ...options, outputRoot: path.join(outputRoot, 'wrong-receipt'), klibComponent: { ...klibComponent, receipt: { ...klibComponent.receipt, sourceLockSha256: '0'.repeat(64) } } }), /predecessor receipt object/);
    });
    await negative('wrong predecessor owner', async () => {
        await assert.rejects(prepareKlibSignatureIndex({ ...options, outputRoot: path.join(outputRoot, 'wrong-owner'), retainedSources: [retainedSources[0], { ...retainedSources[1], filename: path.join(outputRoot, 'copied.kt') }] }), /predecessor filename must be unique/);
    });
    await negative('missing final helper', async () => { await assert.rejects(final({ retainedSources: selected.slice(0, 2) }), /Missing final/); });
    await negative('duplicate final logical path', async () => { await assert.rejects(final({ retainedSources: [...selected, selected[0]] }), /Duplicate signature index selection path/); });
    await negative('duplicate final filename under alias', async () => { await assert.rejects(final({ retainedSources: [...selected, { ...selected[0], path: 'Copy.kt' }] }), /Duplicate signature index selection filename/); });
    await negative('copied source is not canonical owner', async () => {
        const filename = path.join(outputRoot, 'copied-index.kt'); await writeFile(filename, await readFile(selected[0].filename));
        await assert.rejects(final({ retainedSources: [{ ...selected[0], filename }, ...selected.slice(1)] }), /Wrong signature index final owner/);
    });
    await negative('body mutation with honest final digest', async () => {
        const row = selected[0], saved = await readFile(row.filename);
        try {
            await writeFile(row.filename, saved.toString().replace('in 0..2 -> error', 'in 0..1 -> error'));
            await assert.rejects(final({ retainedSources: [await pin(row.path, row.filename), ...selected.slice(1)] }), /Pinned source content mismatch/);
        } finally { await writeFile(row.filename, saved); }
    });
    await negative('predecessor bytes changed after binding', async () => {
        const saved = await readFile(memory);
        try { await writeFile(memory, Buffer.concat([saved, Buffer.from('\n')])); await assert.rejects(final(), /Pinned source (length|content) mismatch/); }
        finally { await writeFile(memory, saved); }
    });
    await negative('predecessor receipt changed after binding', async () => {
        const filename = klibComponent.receiptPath, saved = await readFile(filename);
        try { await writeFile(filename, Buffer.concat([saved, Buffer.from('\n')])); await assert.rejects(final(), /predecessor receipt changed/); }
        finally { await writeFile(filename, saved); }
    });
    await negative('helper inventory name changed with honest pin', async () => {
        const row = selected[2], saved = await readFile(row.filename);
        try {
            await writeFile(row.filename, saved.toString().replace('-> "FileSignature"', '-> "WrongSignature"'));
            await assert.rejects(final({ retainedSources: [...selected.slice(0, 2), await pin(row.path, row.filename)] }), /Pinned source content mismatch/);
        } finally { await writeFile(row.filename, saved); }
    });
    const recordedPropertyImports = ['org.jetbrains.kotlin.portable.common.*', 'org.jetbrains.kotlin.portable.descriptors.*'];
    const recorded = '\n' + recordedPropertyImports.map(name => 'import ' + name).join('\n') + '\n';
    const assembly = '\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n\nimport kotlin.jvm.*\n' + recorded;
    for (const row of selected) { const bytes = await readFile(row.filename); await writeFile(row.filename, bytes.toString().replace(/(^package[^\n]+)/m, '$1' + assembly)); }
    selected = await Promise.all(selected.map(row => pin(row.path, row.filename)));
    assert.equal((await final({ recordedPropertyImports })).receipt.checked.length, 3);
    await negative('unrecorded assembly imports', async () => { await assert.rejects(final({ recordedPropertyImports: [] }), /Pinned source (length|content) mismatch/); });
    const restored = await final({ recordedPropertyImports });
    const result = { result: 'pass', publicGuardRejections: checks.length, checks, positivePreparation: true, positiveReplay: true,
        positiveFinal: true, positiveRecordedImports: true, final: restored.receipt, outputRoot };
    await writeJson(path.join(outputRoot, 'integrity.json'), result); console.log(JSON.stringify({ outputRoot, checks: checks.length, result: 'pass' }));
});

test('exact recipe rejects ambiguous input and round-trips complete sources', async () => {
    const original = await readFile(path.join(REPO, 'out/kotlin-compiler-port/sources', INDEX));
    const memory = await readFile(path.join(HERE, '../klib/MemoryKotlinLibrary.kt'));
    for (const [bytes, recipe] of [[original, indexChanges], [memory, memoryChanges]]) {
        assert.deepEqual(applyExact(applyExact(bytes, recipe), recipe, true), bytes);
        assert.throws(() => applyExact(Buffer.concat([bytes, bytes]), recipe), /Expected one exact/);
    }
    assert.throws(() => normalizeImports(Buffer.from('package p\nimport kotlin.jvm.*\n\nimport kotlin.jvm.*\n')), /Duplicate/);
});
