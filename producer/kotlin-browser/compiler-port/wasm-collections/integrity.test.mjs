import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readRegular } from '../../scripts/source.mjs';
import { prepareIdentitySources } from '../identity/prepare.mjs';
import { prepareCompilerTextSources } from '../text/prepare.mjs';
import { prepareWasmCollectionsSources, verifyWasmCollectionsInputs } from './prepare.mjs';
import { CONTEXT, FRAGMENT, WRITER, PATHS, transformWasmCollections } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources');

async function fixture() {
    const parent = path.join(repository, 'out/kotlin-wasm-collections-guards'); await mkdir(parent, { recursive: true });
    const root = await mkdtemp(path.join(parent, 'run-'));
    const preparedIdentity = await prepareIdentitySources({ sourceRoot, outputRoot: path.join(root, 'identity') });
    const preparedText = await prepareCompilerTextSources({ sourceRoot, outputRoot: path.join(root, 'text') });
    return { sourceRoot, root, preparedIdentity, preparedText };
}

test('three final sources preserve exact predecessor changes and bind source identity once', async () => {
    const input = await fixture(); const result = await prepareWasmCollectionsSources({ ...input, outputRoot: path.join(input.root, 'layer') });
    assert.deepEqual(result.replacedOriginalPaths, PATHS); assert.equal(result.commonSources.length, 3);
    assert.deepEqual(result.predecessorBindings.map(pin => pin.component), ['identityReceipt', 'textReceipt']);
    const fragment = (await readRegular(result.commonSources[0])).toString(); const writer = (await readRegular(result.commonSources[2])).toString();
    assert(fragment.includes('IdentityIndex')); assert(!fragment.includes('IdentityHashMap'));
    assert(fragment.includes('getOrPut(string)')); assert(writer.includes('compilerUtf8Bytes as toByteArray'));
    assert(writer.includes('.toList().sortedBy { it.first }')); assert(!writer.includes('.toSortedMap()'));
});

test('changed identity preparation bytes fail before output or compiler execution', async () => {
    const input = await fixture(); const filename = input.preparedIdentity.commonSources.find(name => name.endsWith('/' + FRAGMENT));
    await writeFile(filename, Buffer.concat([await readRegular(filename), Buffer.from('\n')]));
    await assert.rejects(verifyWasmCollectionsInputs(input), /Changed prepared predecessor bytes|strictly equal/);
});

test('changed text preparation bytes fail before output or compiler execution', async () => {
    const input = await fixture(); const filename = input.preparedText.commonSources.find(name => name.endsWith('/' + WRITER));
    await writeFile(filename, Buffer.concat([await readRegular(filename), Buffer.from('\n')]));
    await assert.rejects(verifyWasmCollectionsInputs(input));
});

test('stale predecessor receipt lock is rejected even when object and disk agree', async () => {
    const input = await fixture(); input.preparedText.receipt.sourceLockSha256 = '0'.repeat(64);
    await writeFile(input.preparedText.receiptPath, JSON.stringify(input.preparedText.receipt));
    await assert.rejects(verifyWasmCollectionsInputs(input));
});

test('missing or duplicate selected predecessor inputs are rejected', async () => {
    const input = await fixture(); const filename = input.preparedIdentity.commonSources.find(name => name.endsWith('/' + FRAGMENT));
    input.preparedIdentity.commonSources.push(filename); await assert.rejects(verifyWasmCollectionsInputs(input), /exactly once/);
    input.preparedIdentity.commonSources = input.preparedIdentity.commonSources.filter(name => name !== filename);
    await assert.rejects(verifyWasmCollectionsInputs(input), /exactly once/);
});

test('changed original context bytes and repeated transformation are rejected', async () => {
    const input = await fixture(); const copyRoot = path.join(input.root, 'original-copy');
    for (const logical of PATHS) {
        const filename = path.join(copyRoot, logical); await mkdir(path.dirname(filename), { recursive: true });
        const bytes = await readRegular(path.join(sourceRoot, logical));
        await writeFile(filename, logical === CONTEXT ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes);
    }
    await assert.rejects(verifyWasmCollectionsInputs({ ...input, sourceRoot: copyRoot }), /Pinned source/);
    const original = await readRegular(path.join(sourceRoot, CONTEXT));
    assert.throws(() => transformWasmCollections(CONTEXT, transformWasmCollections(CONTEXT, original)), /Selected source operation changed/);
});
