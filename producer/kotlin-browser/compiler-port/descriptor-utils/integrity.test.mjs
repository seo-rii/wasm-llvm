import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareDescriptorUtilsSources } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const REPO = path.resolve(HERE, '../../../..');
const SOURCE = path.join(REPO, 'out/kotlin-compiler-port/sources'); const lock = JSON.parse(await readFile(path.join(HERE, 'sources.lock.json')));

test('selected common descriptor algorithms omit Java Class adapters and bind the real selected caller', async () => {
    const outputRoot = await mkdtemp(path.join(REPO, 'out/kotlin-descriptor-utils-integrity-'));
    const result = await prepareDescriptorUtilsSources({ sourceRoot: SOURCE, outputRoot });
    assert.equal(result.commonSources.length, 3); assert.equal(result.receipt.methods, 70);
    assert.equal(result.receipt.jvmAdapter, false); assert.equal(result.receipt.readiness, false);
    const source = await readFile(result.commonSources[0], 'utf8');
    assert(!source.includes('java.lang.Class')); assert(!source.includes('aClass.isInstance'));
    assert((await readFile(result.commonSources[2], 'utf8')).includes('DescriptorType.PACKAGE_FRAGMENT'));
    await assert.rejects(prepareDescriptorUtilsSources({ sourceRoot: SOURCE, outputRoot }), /EEXIST/);
});

test('the legitimate JVM variant retains real Class traversal separately', async () => {
    const outputRoot = await mkdtemp(path.join(REPO, 'out/kotlin-descriptor-utils-jvm-'));
    const result = await prepareDescriptorUtilsSources({ sourceRoot: SOURCE, outputRoot, jvmAdapter: true });
    const source = await readFile(result.commonSources[0], 'utf8');
    assert(source.includes('aClass.isInstance(current)')); assert.equal(result.receipt.jvmAdapter, true);
    assert(source.includes('it.javaClass')); assert.equal(result.receipt.readiness, false);
});

test('corrupt original algorithm bytes fail before generated source output', async () => {
    const root = await mkdtemp(path.join(REPO, 'out/kotlin-descriptor-utils-corrupt-')); const sourceRoot = path.join(root, 'sources');
    for (const pin of lock.sources) {
        const target = path.join(sourceRoot, pin.path); await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(SOURCE, pin.path), target);
    }
    const source = path.join(sourceRoot, lock.originalJavaPath); const bytes = await readFile(source); bytes[0] ^= 1; await writeFile(source, bytes);
    const outputRoot = path.join(root, 'common');
    await assert.rejects(prepareDescriptorUtilsSources({ sourceRoot, outputRoot }), /Pinned source content mismatch/);
    await assert.rejects(stat(path.join(outputRoot, lock.portable.outputPath)), /ENOENT/);
});

test('source cache mutation and outputs outside out are rejected', async () => {
    await assert.rejects(prepareDescriptorUtilsSources({ sourceRoot: SOURCE, outputRoot: SOURCE }));
    await assert.rejects(prepareDescriptorUtilsSources({ sourceRoot: SOURCE, outputRoot: '/tmp/kotlin-descriptor-utils' }));
});
