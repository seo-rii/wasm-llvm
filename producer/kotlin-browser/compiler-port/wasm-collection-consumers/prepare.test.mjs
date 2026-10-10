import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareIdentitySources } from '../identity/prepare.mjs';
import { prepareCompilerTextSources } from '../text/prepare.mjs';
import { prepareWasmCollectionsSources } from '../wasm-collections/prepare.mjs';
import { prepareWasmCollectionConsumers, verifyWasmCollectionConsumers } from './prepare.mjs';
import { CONTEXT, FRAGMENT, PATHS, transformWasmCollectionConsumer } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources'), lock = JSON.parse(await readFile(path.join(here, 'sources.lock.json')));

async function fixture(root) {
    const identity = await prepareIdentitySources({ sourceRoot, outputRoot: path.join(root, 'identity') });
    const preparedText = await prepareCompilerTextSources({ sourceRoot, outputRoot: path.join(root, 'text') });
    const preparedWasmCollections = await prepareWasmCollectionsSources({ sourceRoot, outputRoot: path.join(root, 'collections'), preparedIdentity: identity, preparedText });
    return { sourceRoot, preparedText, preparedWasmCollections };
}
async function isolated(action) { const root = await mkdtemp(path.join(repository, 'out/kotlin-wasm-consumer-guard-'));
    try { await action(root, await fixture(root)); } finally { await rm(root, { recursive: true, force: true }); } }

test('all bytes outside selected imports/calls retain their exact genuine predecessor', async () => isolated(async (root, input) => {
    for (const logical of PATHS) {
        const before = await readFile(input.preparedWasmCollections.commonSources.find(file => file.endsWith('/' + logical)));
        const result = transformWasmCollectionConsumer(logical, before, lock); let restored = result.bytes;
        for (const change of result.changes.toReversed()) {
            assert.equal(restored.subarray(change.offset, change.offset + change.replacementBytes).toString(), change.replacement);
            restored = Buffer.concat([restored.subarray(0, change.offset), Buffer.from(change.original), restored.subarray(change.offset + change.replacementBytes)]);
        }
        assert.deepEqual(restored, before);
        if (logical === CONTEXT) assert(result.bytes.includes(Buffer.from('val codePoint = (current and MASK_7).toByte()\n        current = current shr 7')));
        if (logical === FRAGMENT) assert(result.bytes.includes(Buffer.from('stringDataSectionBytes.toByteArray()')));
    }
}));

test('changed map canonicalization, low-63-bit loop or prepared predecessor is rejected', async () => isolated(async (root, input) => {
    for (const [logical, old, replacement] of [[FRAGMENT, '!= canonicalSignature', '== canonicalSignature'],
        [FRAGMENT, 'allFunctionTypes.reverse()', 'allFunctionTypes.toMap()'], [CONTEXT, 'current shr 7', 'current shr 6']]) {
        const original = await readFile(input.preparedWasmCollections.commonSources.find(file => file.endsWith('/' + logical)));
        assert.throws(() => transformWasmCollectionConsumer(logical, Buffer.from(original.toString().replace(old, replacement)), lock), /predecessor/);
    }
}));

test('two full outputs, two checked replacements and existing UTF8 dependencies verify without duplication', async () => isolated(async (root, input) => {
    const prepared = await prepareWasmCollectionConsumers({ ...input, outputRoot: path.join(root, 'prepared') });
    const result = await verifyWasmCollectionConsumers(prepared.outputRoot);
    assert.deepEqual(result.receipt, prepared.receipt); assert.equal(prepared.commonSources.length, 2);
    assert.equal(prepared.predecessorBindings.length, 2); assert.equal(prepared.sharedDependencies.length, 2);
    const file = prepared.commonSources[0], bytes = await readFile(file);
    await writeFile(file, Buffer.from(bytes.toString().replace('v to k', 'k to v'))); await assert.rejects(verifyWasmCollectionConsumers(prepared.outputRoot));
    await writeFile(file, bytes);
    const reference = path.join(prepared.outputRoot, 'reference/upstream/util.kt'), original = await readFile(reference);
    await writeFile(reference, Buffer.from(original.toString().replace('v to k', 'k to v'))); await assert.rejects(verifyWasmCollectionConsumers(prepared.outputRoot));
}));

test('altered or duplicated shared sources and output overlap fail closed', async () => isolated(async (root, input) => {
    const api = input.preparedText.commonSources.find(file => file.endsWith('/CompilerUtf8Api.kt')), bytes = await readFile(api);
    await writeFile(api, Buffer.concat([bytes, Buffer.from('\n')]));
    await assert.rejects(prepareWasmCollectionConsumers({ ...input, outputRoot: path.join(root, 'changed') }));
    await writeFile(api, bytes);
    await assert.rejects(prepareWasmCollectionConsumers({ ...input, outputRoot: path.join(root, 'duplicated'),
        preparedText: { ...input.preparedText, commonSources: [...input.preparedText.commonSources, api] } }));
    await assert.rejects(prepareWasmCollectionConsumers({ ...input, outputRoot: path.dirname(input.preparedWasmCollections.receiptPath) }), /overlap/);
}));

test('declared dependency/output pins and stored immutable UTF8 bytes cannot drift', async () => isolated(async (root, input) => {
    const receipt = structuredClone(input.preparedWasmCollections.receipt); receipt.files.find(item => item.path === FRAGMENT).sha256 = '0'.repeat(64);
    const receiptPath = path.join(root, 'wrong.json'); await writeFile(receiptPath, JSON.stringify(receipt));
    await assert.rejects(prepareWasmCollectionConsumers({ ...input, outputRoot: path.join(root, 'wrong'),
        preparedWasmCollections: { ...input.preparedWasmCollections, receiptPath, receipt } }));
    const prepared = await prepareWasmCollectionConsumers({ ...input, outputRoot: path.join(root, 'prepared') });
    const api = path.join(prepared.outputRoot, 'dependencies/textReceipt/CompilerUtf8Api.kt'), bytes = await readFile(api);
    await writeFile(api, Buffer.concat([bytes, Buffer.from('\n')])); await assert.rejects(verifyWasmCollectionConsumers(prepared.outputRoot));
}));
