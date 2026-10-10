import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { bindNullConstant, prepareNullConstantValue, verifyNullConstantValue, ORIGINAL, COMMON } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources'), lock = JSON.parse(await readFile(path.join(here, 'sources.lock.json')));
const root = await mkdtemp(path.join(repository, 'out/kotlin-null-constant-guards-'));
after(async () => rm(root, { recursive: true, force: true }));

test('the single type argument is the only changed source span', async () => {
    const original = await readFile(path.join(sourceRoot, lock.sources[0].path)), common = bindNullConstant(original);
    assert.equal(common.toString().replace(COMMON, ORIGINAL), original.toString());
    assert.equal(common.length - original.length, 3);
    assert.throws(() => bindNullConstant(Buffer.from(original.toString().replace(ORIGINAL, COMMON))));
    assert.throws(() => bindNullConstant(Buffer.concat([original, Buffer.from(ORIGINAL)])));
});

test('original source and visitor references replay independently', async () => {
    const component = await prepareNullConstantValue({ sourceRoot, outputRoot: path.join(root, 'replay') });
    const checked = await verifyNullConstantValue(component.outputRoot); assert.deepEqual(checked.receipt, component.receipt);
    assert.equal(component.commonSources.length, 1); assert.equal(component.replacedOriginalPaths.length, 1);
    const reference = path.join(component.outputRoot, 'reference', lock.sources[1].path), original = await readFile(reference);
    await writeFile(reference, original.toString().replace('R visitNullValue', 'R changedNullValue'));
    await assert.rejects(verifyNullConstantValue(component.outputRoot));
});

test('changed method bodies and forged receipt claims fail verification', async () => {
    const component = await prepareNullConstantValue({ sourceRoot, outputRoot: path.join(root, 'mutated') });
    const file = component.commonSources[0], bytes = await readFile(file);
    await writeFile(file, bytes.toString().replace('value?.hashCode() ?: 0', '0'));
    await assert.rejects(verifyNullConstantValue(component.outputRoot)); await writeFile(file, bytes);
    const receipt = JSON.parse(await readFile(component.receiptPath)); receipt.fullConstantsWasmExecuted = true;
    await writeFile(component.receiptPath, JSON.stringify(receipt)); await assert.rejects(verifyNullConstantValue(component.outputRoot));
});

test('input/output overlap and reuse cannot overwrite original or prepared sources', async () => {
    await assert.rejects(prepareNullConstantValue({ sourceRoot, outputRoot: sourceRoot }));
    const options = { sourceRoot, outputRoot: path.join(root, 'reuse') };
    await prepareNullConstantValue(options); await assert.rejects(prepareNullConstantValue(options));
});
