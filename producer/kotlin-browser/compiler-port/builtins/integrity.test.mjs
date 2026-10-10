import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareBuiltInsSources } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const SOURCE = path.join(REPO, 'out/kotlin-compiler-port/sources');
const lock = JSON.parse(await readFile(path.join(HERE, 'sources.lock.json')));

test('actual selected source preparation retains all methods, two real classes and disabled readiness', async () => {
    const outputRoot = await mkdtemp(path.join(REPO, 'out/kotlin-builtins-integrity-'));
    const result = await prepareBuiltInsSources({ sourceRoot: SOURCE, outputRoot });
    assert.equal(result.commonSources.length, 2);
    assert.equal(result.receipt.methods, 168);
    assert.equal(result.receipt.syntheticGetterAliases, 70);
    assert.equal(result.receipt.readiness, false);
    assert.equal(result.receipt.browserCompilerBuilt, false);
    assert.deepEqual(result.replacedOriginalPaths, lock.replacedOriginalPaths);
    await assert.rejects(prepareBuiltInsSources({ sourceRoot: SOURCE, outputRoot }), /EEXIST/);
});

test('changed original Java source is rejected before portable source writes', async () => {
    const root = await mkdtemp(path.join(REPO, 'out/kotlin-builtins-corrupt-'));
    const sourceRoot = path.join(root, 'originals');
    for (const pin of lock.sources) {
        const destination = path.join(sourceRoot, pin.path);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(path.join(SOURCE, pin.path), destination);
    }
    const original = path.join(sourceRoot, lock.originalJavaPath);
    const bytes = await readFile(original); bytes[0] ^= 1;
    await writeFile(original, bytes);
    const outputRoot = path.join(root, 'portable');
    await assert.rejects(prepareBuiltInsSources({ sourceRoot, outputRoot }), /Pinned source content mismatch/);
    await assert.rejects(stat(path.join(outputRoot, lock.portable.outputPath)), /ENOENT/);
});

test('the original source directory and outputs outside producer out are rejected', async () => {
    await assert.rejects(prepareBuiltInsSources({ sourceRoot: SOURCE, outputRoot: SOURCE }), /Do not change the original source cache/);
    await assert.rejects(prepareBuiltInsSources({ sourceRoot: SOURCE, outputRoot: '/tmp/kotlin-builtins-port' }), /must be generated under out/);
});
