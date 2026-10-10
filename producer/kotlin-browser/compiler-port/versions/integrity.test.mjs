import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { resolveBuildVersion } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
const input = JSON.parse(await readRegular(path.join(REPO, 'producer/kotlin-browser/compiler-port/compiler-version-input.json')));

async function fixture(run) {
    const temp = await mkdtemp(path.join(REPO, 'out/kotlin-version-guard-'));
    try {
        const repo = path.join(temp, 'repository');
        const unit = path.join(repo, 'producer/kotlin-browser/compiler-port/versions');
        await mkdir(unit, { recursive: true, mode: 0o700 });
        for (const name of ['prepare.mjs', 'sources.lock.json', 'update-recipe.py', lock.unicodePolicyOrigin.generator.path,
            lock.unicodePolicy.path, lock.patch.path, ...lock.portableFiles.map(pin => pin.path)]) {
            const filename = path.join(unit, name); await mkdir(path.dirname(filename), { recursive: true });
            await copyFile(path.join(HERE, name), filename);
        }
        const sourceHelper = path.join(repo, 'producer/kotlin-browser/scripts/source.mjs');
        await mkdir(path.dirname(sourceHelper), { recursive: true });
        await copyFile(path.join(HERE, '../../scripts/source.mjs'), sourceHelper);
        const sourceRoot = path.join(repo, 'out/closure'); const additionalSourceRoot = path.join(repo, 'out/additional');
        for (const pin of [...lock.sources, ...lock.references]) {
            const origin = path.join(REPO, pin.location === 'closure' ? 'out/kotlin-compiler-port/sources' : 'out/kotlin-versions-reference-inputs', pin.path);
            const destination = path.join(pin.location === 'closure' ? sourceRoot : additionalSourceRoot, pin.path);
            await mkdir(path.dirname(destination), { recursive: true }); await copyFile(origin, destination);
        }
        const buildVersionInput = path.join(temp, 'input.json');
        const inputBytes = Buffer.from(JSON.stringify(input)); await writeFile(buildVersionInput, inputBytes, { flag: 'wx', mode: 0o600 });
        const prepare = (await import(pathToFileURL(path.join(unit, 'prepare.mjs')).href)).prepareVersionSources;
        await run({ temp, unit, sourceRoot, additionalSourceRoot, buildVersionInput, inputBytes, prepare,
            options: { sourceRoot, additionalSourceRoot, outputRoot: path.join(repo, 'out/prepared'), buildVersionInput,
                buildVersionInputSha256: sha256(inputBytes) } });
    } finally { await rm(temp, { recursive: true, force: true }); }
}

test('Actual default.snapshot deploy override beats a present build.number', () => {
    const changed = structuredClone(input);
    changed.properties.deployVersion = 'default.snapshot'; changed.properties.buildNumber = '8.0.0-release-123';
    assert.equal(resolveBuildVersion(changed, '2.5.255-SNAPSHOT'), '2.5.255-SNAPSHOT');
});

test('Actual absent deploy override chooses build.number, then pinned default', () => {
    const changed = structuredClone(input);
    changed.properties.buildNumber = '8.0.0-release-123';
    assert.equal(resolveBuildVersion(changed, '2.5.255-SNAPSHOT'), '8.0.0-release-123');
    changed.properties.deployVersion = '9.0.0-RC-7';
    assert.equal(resolveBuildVersion(changed, '2.5.255-SNAPSHOT'), '9.0.0-RC-7');
    assert.equal(resolveBuildVersion(input, '2.5.255-SNAPSHOT'), '2.5.255-SNAPSHOT');
});

test('Unresolved, missing, multiline and mismatched version inputs fail closed', () => {
    for (const value of ['@snapshot@', '', '2.5\n.0', '2.5\r.0', '2.5\0.0']) {
        const changed = structuredClone(input); changed.properties.deployVersion = value;
        assert.throws(() => resolveBuildVersion(changed, '2.5.255-SNAPSHOT'));
    }
    const missing = structuredClone(input); delete missing.properties.deployVersion;
    assert.throws(() => resolveBuildVersion(missing, '2.5.255-SNAPSHOT'));
    assert.throws(() => resolveBuildVersion(input, '2.5.254-SNAPSHOT'));
});

test('Preparation binds the genuine resource, exact original bytes and generated common sources', async () => fixture(async f => {
    const prepared = await f.prepare(f.options);
    assert.equal(prepared.commonSources.length, 6); assert.equal(prepared.originalSources.length, 3);
    assert.equal((await readFile(prepared.resourcePath)).toString(), '2.5.255-SNAPSHOT');
    assert.equal(prepared.receipt.versionGeneration.inputSha256, sha256(f.inputBytes));
    assert.equal(prepared.receipt.originalSourceUnmodified, true); assert.equal(prepared.receipt.readiness, false);
    for (const pin of lock.sources) assert.equal(sha256(await readFile(path.join(pin.location === 'closure' ? f.sourceRoot : f.additionalSourceRoot, pin.path))), pin.sha256);
}));

test('Producer input digest mismatch cannot produce a compiler version resource', async () => fixture(async f => {
    await assert.rejects(f.prepare({ ...f.options, buildVersionInputSha256: '0'.repeat(64) }), /digest mismatch/);
    await assert.rejects(readFile(path.join(f.options.outputRoot, 'resources/META-INF/compiler.version')), { code: 'ENOENT' });
}));

test('Missing explicit input cannot use a bootstrap or target stdlib version', async () => fixture(async f => {
    await assert.rejects(f.prepare({ ...f.options, buildVersionInput: undefined }), /bound producer build-version input/);
}));

test('Corrupt official Java input is rejected before source preparation', async () => fixture(async f => {
    const pin = lock.sources.find(pin => pin.location === 'closure');
    const filename = path.join(f.sourceRoot, pin.path); const bytes = await readFile(filename); bytes[100] ^= 1; await writeFile(filename, bytes);
    await assert.rejects(f.prepare(f.options), /Pinned source content mismatch/);
}));

test('Corrupt Unicode policy cannot silently use browser locale/case tables', async () => fixture(async f => {
    const filename = path.join(f.unit, lock.unicodePolicy.path); const bytes = await readFile(filename); bytes[300] ^= 1; await writeFile(filename, bytes);
    await assert.rejects(f.prepare(f.options), /Assertion/);
}));

test('Changed common algorithm is rejected by its source lock', async () => fixture(async f => {
    const filename = path.join(f.unit, 'MavenComparableVersion.kt'); const bytes = await readFile(filename); bytes[1200] ^= 1; await writeFile(filename, bytes);
    await assert.rejects(f.prepare(f.options), /Assertion/);
}));

test('An unrelated upstream property blob cannot identify the compiler', async () => fixture(async f => {
    const changed = structuredClone(input); changed.upstreamProperty.gitBlob = '0'.repeat(40);
    const bytes = Buffer.from(JSON.stringify(changed)); await writeFile(f.buildVersionInput, bytes);
    await assert.rejects(f.prepare({ ...f.options, buildVersionInputSha256: sha256(bytes) }), /property pin mismatch/);
}));

test('Preparation refuses source symlinks and output replacement', async () => fixture(async f => {
    const prepared = await f.prepare(f.options); const before = await readFile(prepared.resourcePath);
    await assert.rejects(f.prepare(f.options), { code: 'EEXIST' });
    assert.deepEqual(await readFile(prepared.resourcePath), before);
    const link = path.join(f.temp, 'source-link'); await symlink(f.sourceRoot, link);
    await assert.rejects(f.prepare({ ...f.options, sourceRoot: link, outputRoot: path.join(path.dirname(f.options.outputRoot), 'second') }), /Symlink/);
}));

for (const [name, cacheKey, child] of [
    ['primary cache descendant', 'sourceRoot', true],
    ['additional reference cache root', 'additionalSourceRoot', false],
    ['additional reference cache descendant', 'additionalSourceRoot', true],
]) {
    test('Preparation refuses output in the ' + name + ' before writing cache files', async () => fixture(async f => {
        const cacheRoot = f.options[cacheKey];
        const before = await readdir(cacheRoot);
        const outputRoot = child ? path.join(cacheRoot, 'generated-version-output') : cacheRoot;
        await assert.rejects(f.prepare({ ...f.options, outputRoot }), /overlaps original source cache/);
        assert.deepEqual(await readdir(cacheRoot), before);
    }));
}
