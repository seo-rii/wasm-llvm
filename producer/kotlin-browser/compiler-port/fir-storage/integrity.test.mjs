import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { projectTraversal } from './traversal.mjs';
import { verifyEvidence } from './verify.mjs';

const execute = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const originals = path.join(repository, 'out/kotlin-compiler-port/sources');

async function fixture(action) {
    const temporary = await mkdtemp(path.join(repository, 'out/kotlin-fir-storage-guard-'));
    const isolated = path.join(temporary, 'repository');
    const unit = path.join(isolated, 'producer/kotlin-browser/compiler-port/fir-storage');
    const sourceRoot = path.join(isolated, 'selected');
    const outputRoot = path.join(isolated, 'out/common');
    try {
        const lock = JSON.parse(await readFile(path.join(here, 'sources.lock.json')));
        await mkdir(path.join(unit, 'patches'), { recursive: true, mode: 0o700 });
        for (const name of ['prepare.mjs', 'sources.lock.json', lock.patch.path, lock.adapter.path, lock.generator.path]) {
            await copyFile(path.join(here, name), path.join(unit, name));
        }
        await copyFile(path.join(here, '../closure.lock.json'), path.join(unit, '../closure.lock.json'));
        const scripts = path.join(isolated, 'producer/kotlin-browser/scripts');
        await mkdir(scripts, { recursive: true, mode: 0o700 });
        await copyFile(path.join(here, '../../scripts/source.mjs'), path.join(scripts, 'source.mjs'));
        for (const pin of [...lock.sources, ...lock.referenceDependencies]) {
            const filename = path.join(sourceRoot, pin.path);
            await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
            await copyFile(path.join(originals, pin.path), filename);
        }
        await mkdir(outputRoot, { recursive: true, mode: 0o700 });
        await execute('git', ['init', '--quiet', outputRoot]);
        const { prepareFirStorageSources } = await import(pathToFileURL(path.join(unit, 'prepare.mjs')).href);
        await action({ isolated, unit, lock, sourceRoot, outputRoot, prepareFirStorageSources });
    } finally {
        assert(temporary.startsWith(path.join(repository, 'out/kotlin-fir-storage-guard-')));
        await rm(temporary, { recursive: true, force: true });
    }
}

test('prepare returns all real replacements and keeps selected/reference originals unchanged', async () => {
    await fixture(async ({ lock, sourceRoot, outputRoot, prepareFirStorageSources }) => {
        const pins = [...lock.sources, ...lock.referenceDependencies];
        const before = await Promise.all(pins.map(pin => readFile(path.join(sourceRoot, pin.path))));
        const result = await prepareFirStorageSources({ sourceRoot, outputRoot });
        assert.equal(result.commonSources.length, 12);
        assert.deepEqual(result.replacedOriginalPaths, lock.sources.map(pin => pin.path));
        assert.equal(result.receipt.readiness, false);
        for (let index = 0; index < pins.length; index++) assert.deepEqual(await readFile(path.join(sourceRoot, pins[index].path)), before[index]);
    });
});

for (const kind of ['selected', 'reference', 'adapter', 'generator', 'patch', 'closure']) {
    test('changed ' + kind + ' bytes are rejected', async () => {
        await fixture(async ({ unit, lock, sourceRoot, outputRoot, prepareFirStorageSources }) => {
            const filename = kind === 'selected' ? path.join(sourceRoot, lock.sources[0].path) :
                kind === 'reference' ? path.join(sourceRoot, lock.referenceDependencies[0].path) :
                kind === 'closure' ? path.join(unit, '../closure.lock.json') : path.join(unit, lock[kind].path);
            await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\n')]));
            await assert.rejects(prepareFirStorageSources({ sourceRoot, outputRoot }));
        });
    });
}

test('duplicate source/reference paths are rejected', async () => {
    await fixture(async ({ unit, lock, sourceRoot, outputRoot, prepareFirStorageSources }) => {
        lock.referenceDependencies[1] = lock.referenceDependencies[0];
        await writeFile(path.join(unit, 'sources.lock.json'), JSON.stringify(lock));
        await assert.rejects(prepareFirStorageSources({ sourceRoot, outputRoot }));
    });
});

test('output cannot overlap or nest inside the original source cache', async () => {
    await fixture(async ({ sourceRoot, prepareFirStorageSources }) => {
        await assert.rejects(prepareFirStorageSources({ sourceRoot, outputRoot: sourceRoot }));
        await assert.rejects(prepareFirStorageSources({ sourceRoot, outputRoot: path.join(sourceRoot, 'generated') }));
    });
});

test('original source files cannot be symlinks', async () => {
    await fixture(async ({ lock, sourceRoot, outputRoot, prepareFirStorageSources }) => {
        const filename = path.join(sourceRoot, lock.sources[0].path);
        await rm(filename); await symlink(path.join(originals, lock.sources[0].path), filename);
        await assert.rejects(prepareFirStorageSources({ sourceRoot, outputRoot }));
    });
});

test('prepared output is write-once', async () => {
    await fixture(async ({ sourceRoot, outputRoot, prepareFirStorageSources }) => {
        await prepareFirStorageSources({ sourceRoot, outputRoot });
        await assert.rejects(prepareFirStorageSources({ sourceRoot, outputRoot }), { code: 'EEXIST' });
    });
});

test('locked fillUnboundSymbols projection rejects changed control flow', async () => {
    const lock = JSON.parse(await readFile(path.join(here, 'sources.lock.json')));
    const source = await readFile(path.join(originals, lock.traversal.sourcePath), 'utf8');
    const projected = projectTraversal(source, lock.traversal);
    assert.equal(projected.fullFirExecution, false);
    assert.equal(projected.substitutions.length, 4);
    assert.match(projected.source, /if \(isBound\(irSymbol\)\) continue/);
    assert.throws(() => projectTraversal(source.replace('if (irSymbol.isBound) continue', 'if (!irSymbol.isBound) continue'), lock.traversal));
});

test('checked-in differential evidence binds current sources and excludes compiler readiness', async () => {
    const receipt = JSON.parse(await readFile(path.join(here, 'evidence/fir-storage-differential.json')));
    const result = await verifyEvidence(receipt);
    assert.equal(result.artifactsVerified, false);
    assert.equal(result.browserCompilerBuilt, false);
});

for (const kind of ['count', 'readiness', 'observer', 'artifact-path']) {
    test('changed differential ' + kind + ' claims are rejected', async () => {
        const receipt = JSON.parse(await readFile(path.join(here, 'evidence/fir-storage-differential.json')));
        if (kind === 'count') receipt.comparison.passed--;
        if (kind === 'readiness') receipt.readiness = true;
        if (kind === 'observer') receipt.observers[0].sha256 = '0'.repeat(64);
        if (kind === 'artifact-path') receipt.outputs[0].path = '../outside.jar';
        await assert.rejects(verifyEvidence(receipt));
    });
}
