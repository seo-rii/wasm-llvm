import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sha256 } from '../../scripts/source.mjs';
import { prepareIdentitySources } from '../identity/prepare.mjs';
import { prepareClassifierConstructorGetter, verifyClassifierConstructorGetter } from './prepare.mjs';
import { CONSTRUCTOR_PATH, OWN_BINDINGS, transformClassifierConstructorGetter } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const lock = JSON.parse(await readFile(path.join(here, 'sources.lock.json'))), sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources');
const original = await readFile(path.join(sourceRoot, CONSTRUCTOR_PATH));
const predecessor = Buffer.from(original.toString().replace('    private var hashCode = 0', '    private var hashCode = 0\n    private val identityHashToken = Any()')
    .replace('            System.identityHashCode(this)', '            identityHashToken.hashCode()'));

test('only two own bindings use the original nonnull override; nullable other stays intact', () => {
    const transformed = transformClassifierConstructorGetter(predecessor, lock); let restored = transformed.bytes.toString();
    for (const variable of OWN_BINDINGS) restored = restored.replace('        val ' + variable + ' = getDeclarationDescriptor()\n', '        val ' + variable + ' = declarationDescriptor\n');
    assert.equal(restored, predecessor.toString()); assert.deepEqual(transformed.changes, lock.changes);
    assert(transformed.bytes.includes(Buffer.from('val otherDescriptor = other.declarationDescriptor ?: return false')));
});

test('modified own override, nullable other, cache or equality algorithm cannot enter the layer', () => {
    for (const [before, after] of [['getDeclarationDescriptor(): ClassifierDescriptor', 'getDeclarationDescriptor(): ClassifierDescriptor?'],
        ['other.declarationDescriptor ?: return false', 'other.declarationDescriptor!!'], ['cachedHashCode != 0', 'cachedHashCode == 0'],
        ['other.parameters.size != parameters.size', 'other.parameters.size == parameters.size']]) {
        assert.throws(() => transformClassifierConstructorGetter(Buffer.from(predecessor.toString().replace(before, after)), lock), /predecessor/);
    }
});

test('independent source pins, exact predecessor and output/filename receipt are verified', async () => {
    const root = await mkdtemp(path.join(repository, 'out/kotlin-classifier-getter-guard-'));
    try {
        const preparedIdentity = await prepareIdentitySources({ sourceRoot, outputRoot: path.join(root, 'identity') });
        const prepared = await prepareClassifierConstructorGetter({ sourceRoot, outputRoot: path.join(root, 'prepared'), preparedIdentity });
        await verifyClassifierConstructorGetter(prepared.outputRoot);
        assert.equal(prepared.commonSources.length, 1); assert.equal(prepared.predecessorBindings.length, 1);
        const filename = prepared.commonSources[0], bytes = await readFile(filename); await writeFile(filename, Buffer.concat([bytes, Buffer.from('\n// mutation\n')]));
        await assert.rejects(verifyClassifierConstructorGetter(prepared.outputRoot)); await writeFile(filename, bytes);
        const receiptBytes = await readFile(prepared.receiptPath), receipt = JSON.parse(receiptBytes);
        receipt.predecessorBindings[0].filename = path.join(repository, 'out/unverified', CONSTRUCTOR_PATH);
        await writeFile(prepared.receiptPath, JSON.stringify(receipt)); await assert.rejects(verifyClassifierConstructorGetter(prepared.outputRoot));
        await writeFile(prepared.receiptPath, receiptBytes);
        const reference = path.join(prepared.outputRoot, 'reference', lock.sources[1].path), contract = await readFile(reference);
        await writeFile(reference, Buffer.from(contract.toString().replace('@Nullable', '@NotNull')));
        await assert.rejects(verifyClassifierConstructorGetter(prepared.outputRoot));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('same consumed predecessor bytes cannot hide an altered declared pin or duplicate source', async () => {
    const root = await mkdtemp(path.join(repository, 'out/kotlin-classifier-getter-input-guard-'));
    try {
        const preparedIdentity = await prepareIdentitySources({ sourceRoot, outputRoot: path.join(root, 'identity') });
        const receipt = structuredClone(preparedIdentity.receipt), selected = receipt.files.find(item => item.path === CONSTRUCTOR_PATH);
        selected.sha256 = sha256(Buffer.from('changed'));
        const receiptPath = path.join(root, 'wrong-receipt.json'); await writeFile(receiptPath, JSON.stringify(receipt));
        await assert.rejects(prepareClassifierConstructorGetter({ sourceRoot, outputRoot: path.join(root, 'prepared'),
            preparedIdentity: { ...preparedIdentity, receipt, receiptPath } }));
        await assert.rejects(prepareClassifierConstructorGetter({ sourceRoot, outputRoot: path.join(root, 'duplicate'),
            preparedIdentity: { ...preparedIdentity, commonSources: [...preparedIdentity.commonSources, ...preparedIdentity.commonSources] } }));
        await assert.rejects(prepareClassifierConstructorGetter({ sourceRoot, outputRoot: preparedIdentity.outputRoot, preparedIdentity }), /overlap/);
    } finally { await rm(root, { recursive: true, force: true }); }
});
