import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { javaSessionReferences, guardJavaSessionSelection, verifyFinalFirJavaSessionProfile } from './prepare.mjs';
import { TARGET, REQUIRED, normalizeSessionImports, profileJavaSession } from './transform.mjs';
import { sha256 } from '../../scripts/source.mjs';

test('Java session references cannot hide behind aliases, comments, Unicode or split literals', () => {
    for (const text of [
        'import org.jetbrains.kotlin.fir.session.registerJavaComponents as register; register()',
        'val x = `FirSharableJavaComponents`',
        'val x = "FirSharable" + "JavaComponents"',
        'val x = "registerJava${"Components"}"',
        String.raw`val x = "registerJavaCompon\u0065nts"`,
        'registerJava /* nested /* inner */ comment */ Components()',
        '// registerJavaComponents\nval x = 1',
    ]) assert(javaSessionReferences(text).length > 0, text);
    assert.deepEqual(javaSessionReferences('registerCommonComponents(); FirWasmSessionFactory.WasmWasi'), []);
});

test('only recorded package-prefix imports are normalized without consuming existing whitespace', () => {
    const canonical = Buffer.from('package p\n\nimport already.present\n\nfun x() = 1\n');
    assert.deepEqual(normalizeSessionImports(canonical, canonical), canonical);
    const extras = ['already.present', 'added.member'];
    const prefixed = Buffer.from(canonical.toString().replace('package p', 'package p\nimport added.member\n\nimport kotlin.jvm.*\n'));
    assert.deepEqual(normalizeSessionImports(prefixed, canonical, extras), canonical);
    assert.notDeepEqual(normalizeSessionImports(Buffer.from(canonical.toString().replace('package p', 'package p\nimport unknown.member\n')), canonical, extras), canonical);
});

const fixturePath = process.env.KOTLIN_FIR_JAVA_PROFILE_FIXTURE;
test('final public guard verifies the full actual source list and rejects semantic or binding changes', { skip: !fixturePath }, async t => {
    const fixture = JSON.parse(await readFile(fixturePath)), root = path.dirname(fixturePath);
    const options = { outputRoot: fixture.outputRoot, expectedReceiptSha256: fixture.receiptSha256,
        retainedSources: fixture.finalSources, recordedPropertyImports: fixture.recordedPropertyImports };
    const target = fixture.finalSources.find(pin => pin.path === TARGET);
    const make = async (name, text, logical = name) => {
        const filename = path.join(root, name), bytes = Buffer.from(text); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        return { path: logical, filename, bytes: bytes.length, sha256: sha256(bytes) };
    };
    await t.test('missing unchanged Wasm factory', async () => {
        await assert.rejects(verifyFinalFirJavaSessionProfile({ ...options, retainedSources: fixture.finalSources.filter(pin => pin.path !== REQUIRED[0]) }), /0 !== 1/);
    });
    await t.test('new imported Java registration consumer', async () => {
        const row = await make('JavaConsumer.kt', 'package probe\nimport org.jetbrains.kotlin.fir.session.registerJavaComponents as R\nfun x() = R()\n');
        await assert.rejects(verifyFinalFirJavaSessionProfile({ ...options, retainedSources: [...fixture.finalSources, row] }), /Selected source refers to removed Java/);
    });
    await t.test('duplicate logical source', async () => {
        await assert.rejects(verifyFinalFirJavaSessionProfile({ ...options, retainedSources: [...fixture.finalSources, target] }), /Duplicate physical session input/);
    });
    await t.test('identical body under wrong output owner', async () => {
        const row = await make('WrongOwner.kt', (await readFile(target.filename)).toString(), TARGET);
        await assert.rejects(verifyFinalFirJavaSessionProfile({ ...options, retainedSources: fixture.finalSources.map(pin => pin.path === TARGET ? row : pin) }), /Wrong session output owner/);
    });
    await t.test('changed common algorithm with recomputed selected hash', async () => {
        const original = await readFile(target.filename), changed = Buffer.concat([original, Buffer.from('\n// changed common registration\n')]);
        try {
            await writeFile(target.filename, changed);
            const row = { ...target, bytes: changed.length, sha256: sha256(changed) };
            await assert.rejects(verifyFinalFirJavaSessionProfile({ ...options, retainedSources: fixture.finalSources.map(pin => pin.path === TARGET ? row : pin) }), /Selected common session algorithms changed/);
        } finally { await writeFile(target.filename, original); }
    });
    await t.test('changed factory with recomputed selected hash', async () => {
        const factory = fixture.finalSources.find(pin => pin.path === REQUIRED[0]), original = await readFile(factory.filename);
        const changed = Buffer.concat([original, Buffer.from('\n// changed Wasm registration\n')]);
        try {
            await writeFile(factory.filename, changed); const row = { ...factory, bytes: changed.length, sha256: sha256(changed) };
            await assert.rejects(verifyFinalFirJavaSessionProfile({ ...options, retainedSources: fixture.finalSources.map(pin => pin.path === factory.path ? row : pin) }), /Common or Wasm session factory changed/);
        } finally { await writeFile(factory.filename, original); }
    });
    await t.test('changed preparation receipt', async () => {
        const filename = path.join(fixture.outputRoot, 'fir-java-session-inputs.json'), original = await readFile(filename);
        try {
            await writeFile(filename, Buffer.concat([original, Buffer.from('\n')]));
            await assert.rejects(verifyFinalFirJavaSessionProfile(options), /Session preparation receipt changed/);
        } finally { await writeFile(filename, original); }
    });
    await t.test('missing externally bound preparation digest', async () => {
        await assert.rejects(verifyFinalFirJavaSessionProfile({ ...options, expectedReceiptSha256: undefined }), /Original session receipt binding required/);
    });
    await t.test('unknown recorded import list', async () => {
        await assert.rejects(verifyFinalFirJavaSessionProfile({ ...options, recordedPropertyImports: ['unknown.member'] }), /Unrecorded session property imports/);
    });
    await t.test('missing browser frontend entry', async () => {
        await assert.rejects(verifyFinalFirJavaSessionProfile({ ...options, retainedSources: fixture.finalSources.filter(pin => pin.path !== REQUIRED[2]) }), /Required common and Wasm session boundaries missing/);
    });
    const receipt = await verifyFinalFirJavaSessionProfile(options);
    assert.equal(receipt.guard.inspectedFiles, fixture.finalSources.length);
    assert.equal(receipt.fullCompilerBuilt, false);
    const lock = JSON.parse(await readFile(new URL('./sources.lock.json', import.meta.url))), original = await readFile(fixture.originalTarget.filename);
    assert.equal(sha256(profileJavaSession(original, lock)), lock.output.sha256);
    const model = fixture.finalSources.map(pin => ({ ...pin, source: '' }));
    assert.throws(() => guardJavaSessionSelection(model, Buffer.alloc(0), lock.entry));
});
