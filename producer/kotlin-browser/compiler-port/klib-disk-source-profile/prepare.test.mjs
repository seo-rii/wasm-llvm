import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256, writeJson } from '../../scripts/source.mjs';
import { prepareKlibDiskSourceProfile, verifyKlibDiskFinalSources } from './prepare.mjs';
import { CONFIG, TARGETS, diskReferences, transformConfiguration } from './transform.mjs';

test('disk references include qualified names, aliases, static imports and dynamic literal spellings', () => {
    const examples = [
        'import org.jetbrains.kotlin.io.ZipFileSystemAccessor as Z\nval v: Z? = null',
        'val a = org . jetbrains /* nested /* comment */ */ . kotlin.io.`zipDirAs`',
        'val name = "KlibLayout" + "Reader"',
        'val name = "ZipFile${"System"}CacheableAccessor"',
        String.raw`val name = "loadMetadataKl\u0069bs"`,
        'import static org.jetbrains.kotlin.config.KlibConfigurationKeys.ZIP_FILE_SYSTEM_ACCESSOR;',
        'val value = "${org.jetbrains.kotlin.library.loadSizeInfo(path)}"',
        'import org.jetbrains.kotlin.library.KlibLayoutReader.FromDirectory as D',
    ];
    for (const text of examples) assert(diskReferences(text).length > 0, text);
    assert.deepEqual(diskReferences('import org.jetbrains.kotlin.library.*\nval f: VerifiedKlibFileSet? = null'), []);
});

const fixturePath = process.env.KOTLIN_KLIB_DISK_FIXTURE;
test('public final and preparation guards reject focused recovered-graph mutations', { skip: !fixturePath }, async () => {
    const fixture = JSON.parse(await readFile(fixturePath)), root = path.dirname(fixturePath), checks = [];
    const options = { outputRoot: fixture.outputRoot, expectedReceiptSha256: fixture.expectedReceiptSha256,
        retainedSources: fixture.beforeServiceSources };
    const pin = async (logical, filename) => { const bytes = await readFile(filename); return { path: logical, filename, bytes: bytes.length, sha256: sha256(bytes) }; };
    const testGuard = async (name, fn) => { await fn(); checks.push(name); };
    await verifyKlibDiskFinalSources(options);
    await testGuard('exact disk target reintroduced', async () => {
        const target = fixture.priorSources.find(row => row.path === TARGETS[0]);
        await assert.rejects(verifyKlibDiskFinalSources({ ...options, retainedSources: [target, ...options.retainedSources] }), /Final graph changed/);
    });
    await testGuard('missing genuine memory writer', async () => {
        await assert.rejects(verifyKlibDiskFinalSources({ ...options, retainedSources: options.retainedSources.filter(row => row.path !== 'compiler-port-linker/MemoryKlibOutput.kt') }), /Final graph changed/);
    });
    await testGuard('identical configuration copied to another owner', async () => {
        const current = options.retainedSources.find(row => row.path === CONFIG), filename = path.join(root, 'copied-config.kt');
        await writeFile(filename, await readFile(current.filename), { flag: 'wx', mode: 0o600 });
        await assert.rejects(verifyKlibDiskFinalSources({ ...options, retainedSources: options.retainedSources.map(row => row.path === CONFIG ? { ...row, filename } : row) }), /Final graph changed/);
    });
    await testGuard('configuration algorithm changed with honest digest', async () => {
        const current = options.retainedSources.find(row => row.path === CONFIG), original = await readFile(current.filename);
        try {
            await writeFile(current.filename, original.toString().replace('getList(KlibConfigurationKeys.KLIB_RELATIVE_PATH_BASES)', 'emptyList<String>()'));
            const changed = await pin(CONFIG, current.filename); assert.notEqual(changed.sha256, current.sha256);
            await assert.rejects(verifyKlibDiskFinalSources({ ...options, retainedSources: options.retainedSources.map(row => row.path === CONFIG ? changed : row) }), /Final graph changed/);
        } finally { await writeFile(current.filename, original); }
    });
    await testGuard('unrelated source order changed', async () => {
        const changed = options.retainedSources.slice(); [changed[0], changed[1]] = [changed[1], changed[0]];
        await assert.rejects(verifyKlibDiskFinalSources({ ...options, retainedSources: changed }), /Final graph changed/);
    });
    await testGuard('service removal lacks verified service binding', async () => {
        await assert.rejects(verifyKlibDiskFinalSources({ ...options, retainedSources: fixture.retainedSources }), /Final graph changed/);
    });
    await testGuard('dishonest service predecessor owner with honest receipt digest', async () => {
        const filename = path.join(fixture.serviceLoaderProfile.outputRoot, 'service-loader-inputs.json'), original = await readFile(filename);
        try {
            const changed = JSON.parse(original); const target = changed.selection.sources.find(row => row.path.endsWith('/ServiceLoaderLite.kt')); assert(target);
            target.filename = path.join(root, 'copied-ServiceLoaderLite.kt'); await writeFile(target.filename, await readFile(fixture.priorSources.find(row => row.path === target.path).filename), { flag: 'wx', mode: 0o600 });
            const bytes = Buffer.from(JSON.stringify(changed, null, 2) + '\n'); await writeFile(filename, bytes);
            await assert.rejects(verifyKlibDiskFinalSources({ ...options, retainedSources: fixture.retainedSources,
                serviceLoaderProfile: { ...fixture.serviceLoaderProfile, expectedReceiptSha256: sha256(bytes) } }), /Service preparation did not receive the exact disk output graph/);
        } finally { await writeFile(filename, original); }
    });
    await testGuard('new actual alias and interpolated disk consumer', async () => {
        const filename = path.join(root, 'NewDiskConsumer.kt'); await writeFile(filename,
            'package probe\nimport org.jetbrains.kotlin.library.KlibLayoutReader as Reader\nval name = "Klib${"Layout"}Reader"\n', { flag: 'wx', mode: 0o600 });
        await assert.rejects(prepareKlibDiskSourceProfile({ sourceRoot: fixture.sourceRoot, outputRoot: path.join(root, 'negative-new-reference'),
            retainedSources: [await pin('NewDiskConsumer.kt', filename), ...fixture.priorSources], preparedKlibSignatureIndex: fixture.preparedKlibSignatureIndex,
            recordedPropertyImports: fixture.recordedPropertyImports }), /Actual source refers to excluded KLIB disk declaration/);
    });
    const config = await readFile(path.join(fixture.outputRoot, 'original', CONFIG));
    assert.deepEqual(transformConfiguration(transformConfiguration(config), true), config);
    assert.throws(() => transformConfiguration(Buffer.concat([config, config])), /Expected one exact/);
    const final = await verifyKlibDiskFinalSources({ ...options, retainedSources: fixture.retainedSources, serviceLoaderProfile: fixture.serviceLoaderProfile });
    const result = { schemaVersion: 1, kind: 'klib-disk-profile-integrity', result: 'pass', negativeGuards: checks.length, checks,
        exactConfigurationRoundTrip: true, restoredFinalSources: final.selectedSources, finalReceiptSha256: sha256(Buffer.from(JSON.stringify(final))),
        fixturePath, fullCompilerBuilt: false, languageReadiness: false };
    await writeJson(path.join(root, 'integrity.json'), result); console.log(JSON.stringify({ result: 'pass', checks: checks.length, outputRoot: root }));
});
