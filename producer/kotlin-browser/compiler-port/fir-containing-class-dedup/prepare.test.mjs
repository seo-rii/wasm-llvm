import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sha256 } from '../../scripts/source.mjs';
import { assertPrimaryContainingClassPins, guardContainingClassDeclarations, prepareContainingClassDedup, verifyContainingClassDedup, verifyFinalContainingClassDedup } from './prepare.mjs';
import { DECLARATION, PROVIDER, RESOLVE, deduplicateContainingClass } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources'), lock = JSON.parse(await readFile(path.join(here, 'sources.lock.json')));
const originals = new Map(await Promise.all(lock.sources.map(async pin => [pin.path, await readFile(path.join(sourceRoot, pin.path))])));
const item = (logical, bytes) => ({ path: logical, bytes: bytes.length, sha256: sha256(bytes), source: bytes.toString('base64') });
const snapshot = () => [...originals].map(([logical, bytes]) => item(logical, bytes));
const pins = () => lock.sources.map(pin => ({ ...pin, filename: path.join(sourceRoot, pin.path) }));

test('all official source and Gradle pins are bound to the full primary closure identity', async () => {
    const primary = await readFile(path.join(here, '../closure.lock.json'));
    assertPrimaryContainingClassPins(lock, primary);
    for (const mutate of [copy => { copy.source.treeSha = 'changed'; }, copy => { copy.sources[0].gitBlob = 'changed'; },
        copy => { copy.references[1].sha256 = sha256(Buffer.from('changed')); }, copy => { copy.sources.push(copy.sources[0]); },
        copy => { copy.primaryClosureSha256 = sha256(Buffer.from('other closure')); }]) {
        const changed = structuredClone(lock); mutate(changed); assert.throws(() => assertPrimaryContainingClassPins(changed, primary));
    }
});

test('exact duplicate only is removed; complete provider and every other ResolveUtils byte stay intact', () => {
    const result = deduplicateContainingClass(originals, lock);
    const before = originals.get(RESOLVE), offset = result.removedSpan.offset;
    assert.deepEqual(result.bytes, Buffer.concat([before.subarray(0, offset), before.subarray(offset + Buffer.byteLength(DECLARATION))]));
    assert.equal(result.retainedDeclaration.path, PROVIDER);
    assert.equal(guardContainingClassDeclarations(snapshot(), originals).declarations.length, 2);
    const mutated = new Map(originals); mutated.set(PROVIDER, Buffer.from(originals.get(PROVIDER).toString().replace('FirRegularClass?', 'FirRegularClass')));
    assert.throws(() => deduplicateContainingClass(mutated, lock));
});

test('same declaration counts cannot conceal another table body mutation or missing selected provider', () => {
    const changed = snapshot().map(pin => pin.path === RESOLVE ? item(RESOLVE, Buffer.from(originals.get(RESOLVE).toString().replace('lookupTag.toRegularClassSymbol', 'lookupTag.toClassLikeSymbol'))) : pin);
    assert.throws(() => guardContainingClassDeclarations(changed, originals), /algorithm changed/);
    assert.throws(() => guardContainingClassDeclarations(snapshot().filter(pin => pin.path !== PROVIDER), originals), /Both selected/);
    assert.throws(() => guardContainingClassDeclarations([...snapshot(), snapshot()[0]], originals));
});

test('new same-receiver declarations, direct removed facade access and ambiguous helper imports fail closed', () => {
    for (const body of ['package other\n' + DECLARATION, 'fun call() = ResolveUtilsKt.getContainingClass(receiver)',
        'import org.jetbrains.kotlin.fir.resolve.ResolveUtilsKt.getContainingClass\n', 'import other.getContainingClass\n']) {
        assert.throws(() => guardContainingClassDeclarations([...snapshot(), item('additional/Consumer.kt', Buffer.from(body))], originals));
    }
    const good = item('additional/Consumer.kt', Buffer.from('import org.jetbrains.kotlin.fir.resolve.getContainingClass as findClass\nfun call() = receiver.getContainingClass()\n'));
    assert.equal(guardContainingClassDeclarations([...snapshot(), good], originals).imports.length, 1);
});

test('strict preparation binds original references, snapshot and one selected output', async () => {
    const root = await mkdtemp(path.join(repository, 'out/kotlin-containing-class-guard-'));
    try {
        const prepared = await prepareContainingClassDedup({ sourceRoot, outputRoot: root, retainedSources: pins() });
        await verifyContainingClassDedup(root); assert.deepEqual(prepared.replacedOriginalPaths, [RESOLVE]);
        const output = await readFile(prepared.commonSources[0]); await writeFile(prepared.commonSources[0], Buffer.concat([output, Buffer.from('\n// mutation')]));
        await assert.rejects(verifyContainingClassDedup(root)); await writeFile(prepared.commonSources[0], output);
        const reference = path.join(root, 'reference', PROVIDER), bytes = await readFile(reference);
        await writeFile(reference, Buffer.from(bytes.toString().replace('FirRegularClass?', 'FirRegularClass')));
        await assert.rejects(verifyContainingClassDedup(root));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('final replay accepts only declared assembly imports and verifies mutable output body and exact filename', async () => {
    const root = await mkdtemp(path.join(repository, 'out/kotlin-containing-class-final-'));
    try {
        const prepared = await prepareContainingClassDedup({ sourceRoot, outputRoot: root, retainedSources: pins() });
        const filename = prepared.commonSources[0], canonical = await readFile(filename);
        const assembly = Buffer.from(canonical.toString().replace('package org.jetbrains.kotlin.fir.resolve\n', 'package org.jetbrains.kotlin.fir.resolve\n\nimport kotlin.jvm.*\n'));
        await writeFile(filename, assembly);
        const selected = () => pins().map(pin => pin.path === RESOLVE ? { path: RESOLVE, filename, bytes: assembly.length, sha256: sha256(assembly) } : pin);
        await assert.rejects(verifyContainingClassDedup(root));
        await assert.rejects(verifyFinalContainingClassDedup({ profileRoot: root, retainedSources: selected() }), /Unknown final import/);
        const options = { profileRoot: root, retainedSources: selected(), allowedAddedImports: ['kotlin.jvm.*'] };
        const final = await verifyFinalContainingClassDedup(options); assert.equal(final.guard.declarations.length, 1);
        const moved = path.join(root, 'other.kt'); await writeFile(moved, assembly);
        await assert.rejects(verifyFinalContainingClassDedup({ ...options, retainedSources: selected().map(pin => pin.path === RESOLVE ? { ...pin, filename: moved } : pin) }), /prepared replacement/);
        const changed = Buffer.from(assembly.toString().replace('fun Fir', 'fun ModifiedFir'));
        assert.notEqual(changed.toString(), assembly.toString());
        await writeFile(filename, changed);
        await assert.rejects(verifyFinalContainingClassDedup({ ...options, retainedSources: selected().map(pin => pin.path === RESOLVE ? { ...pin, bytes: changed.length, sha256: sha256(changed) } : pin) }), /algorithm changed/);
        await writeFile(filename, canonical);
        const removed = Buffer.from(canonical.toString().replace('import org.jetbrains.kotlin.KtSourceElement\n', ''));
        await writeFile(filename, removed);
        await assert.rejects(verifyFinalContainingClassDedup({ ...options, retainedSources: selected().map(pin => pin.path === RESOLVE ? { ...pin, bytes: removed.length, sha256: sha256(removed) } : pin) }), /Canonical import removed/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('input/output overlap and selected input hash drift cannot publish preparation', async () => {
    await assert.rejects(prepareContainingClassDedup({ sourceRoot, outputRoot: sourceRoot, retainedSources: pins() }), /overlap/);
    const root = await mkdtemp(path.join(repository, 'out/kotlin-containing-class-input-'));
    try {
        const wrong = pins(); wrong[0].sha256 = sha256(Buffer.from('changed'));
        await assert.rejects(prepareContainingClassDedup({ sourceRoot, outputRoot: root, retainedSources: wrong }));
    } finally { await rm(root, { recursive: true, force: true }); }
});
