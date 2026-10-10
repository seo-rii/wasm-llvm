import assert from 'node:assert/strict';
import { readFile, cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { sha256 } from '../../scripts/source.mjs';
import { applyBuilderRecipes, builderReferences, guardBuilderSelection, algorithm } from './transform.mjs';
import { verifyFinalCopyBuilderPlatform } from './prepare.mjs';
import { verifyFinalDescriptorPlatformSignatures } from '../descriptor-platform-signatures/prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(path.join(HERE, 'sources.lock.json')));
const preparation = process.env.COPY_BUILDER_PREPARATION;
assert(preparation, 'COPY_BUILDER_PREPARATION must identify a verified actual preparation');
const receipt = JSON.parse(await readFile(path.join(preparation, 'receipt.json')));
assert.equal(receipt.sourceLockSha256, sha256(await readFile(path.join(HERE, 'sources.lock.json'))));
const original = new Map();
for (const pin of lock.inputs) {
    const bytes = await readFile(path.join(preparation, 'predecessor', pin.path));
    assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
    original.set(pin.path, bytes);
}
const selected = JSON.parse(gunzipSync(await readFile(path.join(preparation, 'selected-source-snapshot.json.gz'))))
    .map(item => ({ path: item.path, source: Buffer.from(item.source, 'base64') }));

test('six exact metadata spans preserve four complete interface bodies', () => {
    assert.equal(lock.recipes.length, 6);
    for (const pin of lock.outputs) {
        const before = original.get(pin.path);
        const after = applyBuilderRecipes(before, lock.recipes.filter(item => item.path === pin.path));
        assert.equal(after.length, pin.bytes); assert.equal(sha256(after), pin.sha256);
        assert.equal(after.toString().match(/fun build\(\): D\?/g)?.length ?? 0,
            before.toString().match(/fun build\(\): D\?/g)?.length ?? 0);
        assert.equal(after.length - before.length, lock.recipes.filter(item => item.path === pin.path).length);
    }
});

test('source-span changes, wrong replacement and overlapping recipes fail closed', () => {
    const recipe = lock.recipes[0], before = original.get(recipe.path);
    const changed = Buffer.from(before); changed[recipe.startUtf16] ^= 1;
    assert.throws(() => applyBuilderRecipes(changed, [recipe]));
    assert.throws(() => applyBuilderRecipes(before, [{ ...recipe, prepared: recipe.prepared.replace('?>', '>'), preparedSha256: recipe.originalSha256 }]));
    assert.throws(() => applyBuilderRecipes(before, [recipe, recipe]));
});

test('actual selected nullable receiver family is retained and unrecorded contracts rejected', () => {
    const before = guardBuilderSelection(selected, lock.contracts);
    assert.equal(before.declarations.length, 9);
    const error = before.declarations.find(item => item.path.endsWith('/ErrorFunctionDescriptor.kt'));
    assert.equal(error.references.filter(item => item === 'CopyBuilder<SimpleFunctionDescriptor?>').length, 23);
    const after = selected.map(item => ({ ...item, source: original.has(item.path)
        ? applyBuilderRecipes(item.source, lock.recipes.filter(recipe => recipe.path === item.path)) : item.source }));
    assert.equal(guardBuilderSelection(after, lock.contracts, true).declarations.length, 9);
    assert.throws(() => guardBuilderSelection([...after, { path: 'new/Unknown.kt', source: Buffer.from('fun use(x: FunctionDescriptor.CopyBuilder<FunctionDescriptor?>) = x.build()') }], lock.contracts, true), /Unrecorded/);
    assert.throws(() => builderReferences(Buffer.from('typealias Hidden = FunctionDescriptor.CopyBuilder<FunctionDescriptor?>')), /type alias/);
    assert.throws(() => builderReferences(Buffer.from('import org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder as Hidden\n')), /import alias/);
    assert.throws(() => builderReferences(Buffer.from('fun `newCopyBuilder`() = Unit')), /escaped/);
});

test('assembly equivalence ignores only imports and the package header gap', () => {
    const before = original.values().next().value;
    const withImports = before.toString().replace(/(^package[^\n]*\n)/m, '$1\nimport kotlin.jvm.*\n');
    assert.equal(algorithm(Buffer.from(withImports)), algorithm(before));
    assert.notEqual(algorithm(Buffer.from(withImports.replace('newCopyBuilder', 'changedCopyBuilder'))), algorithm(before));
});

test('actual in-place assembly and the verified predecessor view pass strict public final guards',
    { skip: !process.env.COPY_BUILDER_FINAL_OUTPUT }, async () => {
        const root = path.resolve(process.env.COPY_BUILDER_FINAL_OUTPUT);
        assert(root.startsWith(path.resolve(HERE, '../../../../out') + path.sep));
        await mkdir(root, { mode: 0o700 });
        const profileRoot = path.join(root, 'profile');
        await cp(preparation, profileRoot, { recursive: true, errorOnExist: true, force: false });
        const proof = JSON.parse(await readFile(path.join(preparation, 'proof-preparation.json')));
        const allowedAddedImports = ['kotlin.jvm.*', 'org.jetbrains.kotlin.descriptors.*'];
        const finalSources = proof.retainedSources.map(item => lock.outputs.some(pin => pin.path === item.path)
            ? { ...item, filename: path.join(profileRoot, item.path) } : item);
        const assembly = [];
        for (const item of finalSources.filter(item => lock.outputs.some(pin => pin.path === item.path))) {
            const canonical = await readFile(item.filename);
            let text = canonical.toString();
            for (const addition of allowedAddedImports) if (!text.includes('import ' + addition + '\n'))
                text = text.replace(/(^package[^\n]*\n)/m, '$1\nimport ' + addition + '\n');
            const bytes = Buffer.from(text); await writeFile(item.filename, bytes);
            Object.assign(item, { bytes: bytes.length, sha256: sha256(bytes) });
            assembly.push({ path: item.path, filename: item.filename, canonicalSha256: sha256(canonical), bytes: item.bytes, sha256: item.sha256 });
        }
        const final = await verifyFinalCopyBuilderPlatform({ profileRoot, retainedSources: finalSources, allowedAddedImports });
        assert.equal(final.receipt.checked.length, 4);
        const previous = await verifyFinalDescriptorPlatformSignatures({
            profileRoot: receipt.predecessor.outputRoot, retainedSources: final.predecessorRetainedSources, allowedAddedImports });
        assert.equal(previous.checked.length, 11);
        const negatives = [], first = finalSources.find(item => item.path === lock.outputs[0].path);
        const valid = await readFile(first.filename), validPin = { bytes: first.bytes, sha256: first.sha256 };
        async function reject(name, sources) {
            let failure;
            try { await verifyFinalCopyBuilderPlatform({ profileRoot, retainedSources: sources, allowedAddedImports }); }
            catch (error) { failure = error; }
            assert(failure, name + ' must fail'); assert.equal(failure.code, 'ERR_ASSERTION');
            negatives.push({ name, rejected: true, errorCode: failure.code, error: String(failure.message).slice(0, 400) });
        }
        const bodyChanged = Buffer.concat([valid, Buffer.from('\nval unexpectedBodyAddition: Int = 1\n')]);
        await writeFile(first.filename, bodyChanged); Object.assign(first, { bytes: bodyChanged.length, sha256: sha256(bodyChanged) });
        await reject('body changes with identical CopyBuilder expression inventory', finalSources);
        const duplicate = Buffer.from(valid.toString().replace(/(^package[^\n]*\n)/m, '$1import kotlin.jvm.*\n'));
        await writeFile(first.filename, duplicate); Object.assign(first, { bytes: duplicate.length, sha256: sha256(duplicate) });
        await reject('duplicate exact assembly import', finalSources);
        await writeFile(first.filename, valid); Object.assign(first, validPin);
        const wrongFilename = path.join(root, 'same-bytes-wrong-owner.kt'); await writeFile(wrongFilename, valid);
        await reject('same bytes from wrong actual output filename', finalSources.map(item => item === first ? { ...item, filename: wrongFilename } : item));
        await writeFile(path.join(root, 'receipt.json'), JSON.stringify({ schemaVersion: 1,
            kind: 'selected-copy-builder-real-final-assembly-guards', preparationRoot: preparation,
            preparationReceiptSha256: sha256(await readFile(path.join(preparation, 'receipt.json'))),
            observerSha256: sha256(await readFile(fileURLToPath(import.meta.url))), selectedSources: finalSources.length,
            assembly, final: final.receipt, predecessorFinal: previous, negatives,
            actualInPlaceImports: true, oldPredecessorFilesModified: false,
            fullCompilerBuilt: false, languageReadiness: false }, null, 2) + '\n', { mode: 0o600 });
    });
