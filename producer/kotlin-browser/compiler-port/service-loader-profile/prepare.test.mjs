import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { serviceReferences, verifyServiceLoaderFinalSources, TARGET, REQUIRED } from './prepare.mjs';
import { sha256 } from '../../scripts/source.mjs';

test('conservative names include aliases, static imports, comments, interpolation and split strings', () => {
    const cases = [
        'package other; import org.jetbrains.kotlin.util.ServiceLoaderLite as S\nval x = S',
        'package other; import org.jetbrains.kotlin.util.*; val x = `ServiceLoaderLite`',
        'package other; import static org.jetbrains.kotlin.util.ServiceLoaderLite.INSTANCE;',
        'val x = org . jetbrains /* nested /* comment */ here */ . kotlin.util.ServiceLoaderLite',
        'val x = "${org.jetbrains.kotlin.util.ServiceLoaderLite}"',
        'val x = "org.jetbrains.kotlin.util.ServiceLoaderLite"',
        'val x = "ServiceLoader" + "Lite"',
        'val x = "Service${"Loader"}Lite"',
        String.raw`val x = "ServiceLoad\u0065rLite"`,
        'import org.jetbrains.kotlin.util.ServiceLoaderLite.ServiceLoadingException as E',
    ];
    for (const text of cases) assert(serviceReferences(text).length > 0, text);
    assert.deepEqual(serviceReferences('package p\nval x = java.util.ServiceLoader.load(X::class.java)'), []);
});

const fixturePath = process.env.KOTLIN_SERVICE_PROFILE_TEST_FIXTURE;
test('public final guard rejects each actual graph mutation for its intended reason', { skip: !fixturePath }, async t => {
    const fixture = JSON.parse(await readFile(fixturePath)), root = path.dirname(fixturePath);
    const options = { outputRoot: fixture.outputRoot, retainedSources: fixture.finalSources,
        expectedReceiptSha256: fixture.receiptSha256 };
    const first = fixture.finalSources[0];
    const makeFile = async (name, text) => {
        const filename = path.join(root, name); await writeFile(filename, text, { flag: 'wx', mode: 0o600 });
        const bytes = Buffer.from(text); return { path: name, filename, bytes: bytes.length, sha256: sha256(bytes) };
    };
    await t.test('reintroduced exact target', async () => {
        await assert.rejects(verifyServiceLoaderFinalSources({ ...options, retainedSources: [...fixture.finalSources, fixture.target] }), /Excluded ServiceLoaderLite was reintroduced/);
    });
    await t.test('same original copied under a replacement path', async () => {
        const target = { ...fixture.target, path: 'copied/' + TARGET };
        await assert.rejects(verifyServiceLoaderFinalSources({ ...options, retainedSources: [...fixture.finalSources, target] }), /Replacement ServiceLoaderLite was reintroduced/);
    });
    await t.test('new alias/interpolation consumer', async () => {
        const pin = await makeFile('Alias.kt', 'package probe; import org.jetbrains.kotlin.util.ServiceLoaderLite as S\nval a = "${S}"\n');
        await assert.rejects(verifyServiceLoaderFinalSources({ ...options, retainedSources: [...fixture.finalSources, pin] }), /Actual source refers to excluded ServiceLoaderLite/);
    });
    await t.test('new split string consumer', async () => {
        const pin = await makeFile('Literal.kt', 'package probe\nval a = "ServiceLoader" + "Lite"\n');
        await assert.rejects(verifyServiceLoaderFinalSources({ ...options, retainedSources: [...fixture.finalSources, pin] }), /Actual source refers to excluded ServiceLoaderLite/);
    });
    await t.test('missing genuine parser boundary', async () => {
        await assert.rejects(verifyServiceLoaderFinalSources({ ...options, retainedSources: fixture.finalSources.filter(pin => !pin.path.endsWith(REQUIRED[0])) }), /Required genuine algorithm boundary missing or duplicated/);
    });
    await t.test('unrelated byte change with freshly updated pin', async () => {
        const pin = await makeFile('Changed.kt', (await readFile(first.filename)).toString() + '\n// unrelated mutation\n');
        pin.path = first.path;
        await assert.rejects(verifyServiceLoaderFinalSources({ ...options, retainedSources: [pin, ...fixture.finalSources.slice(1)] }), /Final graph changed beyond the one authorized exclusion/);
    });
    await t.test('changed preparation receipt', async () => {
        const filename = path.join(fixture.outputRoot, 'service-loader-inputs.json'), original = await readFile(filename);
        try {
            await writeFile(filename, Buffer.concat([original, Buffer.from('\n')]));
            await assert.rejects(verifyServiceLoaderFinalSources(options), /Preparation receipt changed/);
        } finally { await writeFile(filename, original); }
    });
    await t.test('changed preserved original', async () => {
        const filename = path.join(fixture.outputRoot, 'original', TARGET), original = await readFile(filename);
        try {
            await writeFile(filename, Buffer.concat([original, Buffer.from('\n')]));
            await assert.rejects(verifyServiceLoaderFinalSources(options), error => error.message === 'Pinned source content mismatch: ' + TARGET);
        } finally { await writeFile(filename, original); }
    });
    const final = await verifyServiceLoaderFinalSources(options);
    assert.equal(final.selectedSources, fixture.finalSources.length); assert.equal(final.everyOtherSourceUnchanged, true);
});
