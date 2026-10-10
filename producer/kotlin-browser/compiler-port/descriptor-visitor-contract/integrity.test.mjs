import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before, after } from 'node:test';
import { prepareDescriptorContracts } from '../descriptors/prepare.mjs';
import { sha256 } from '../../scripts/source.mjs';
import { prepareDescriptorVisitorContracts, verifyDescriptorVisitorContracts } from './prepare.mjs';
import { MODULE, OUTPUT, encodeVisitorEntries, inspectVisitorConsumers } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const lock = JSON.parse(await readFile(path.join(HERE, 'sources.lock.json')));
let root, preparedDescriptors, retainedSources, originalSources;
before(async () => {
    root = await mkdtemp(path.join(REPO, 'out/descriptor-visitor-guards-'));
    preparedDescriptors = await prepareDescriptorContracts(sourceRoot, path.join(root, 'descriptor-predecessor'));
    originalSources = await Promise.all(lock.originals.map(async pin => ({ path: pin.path, source: await readFile(path.join(sourceRoot, pin.path)) })));
    const contract = preparedDescriptors.receipt.files.find(pin => pin.path === 'DeclarationDescriptor.kt');
    retainedSources = lock.originals.map(pin => ({ path: pin.path, filename: path.join(sourceRoot, pin.path), bytes: pin.bytes, sha256: pin.sha256 }));
    const visitor = preparedDescriptors.receipt.files.find(pin => pin.path === 'DeclarationDescriptorVisitor.kt');
    retainedSources.push({ path: 'compiler-port-descriptors/generated/DeclarationDescriptorVisitor.kt',
        filename: visitor.absolutePath, bytes: visitor.bytes, sha256: visitor.sha256 });
    retainedSources.push({ path: OUTPUT, filename: contract.absolutePath, bytes: contract.bytes, sha256: contract.sha256 });
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });
const options = name => ({ sourceRoot, preparedDescriptors, retainedSources, outputRoot: path.join(root, name) });

test('twelve checked generic entries preserve nullable base, 29 nullable bodies and all Void declarations', async () => {
    const input = options('valid'), base = await readFile(retainedSources.at(-1).filename);
    const prepared = await prepareDescriptorVisitorContracts(input);
    const verified = await verifyDescriptorVisitorContracts({ ...input, profileRoot: input.outputRoot });
    assert.deepEqual(verified.receipt, prepared.receipt); assert.equal(prepared.commonSources.length, 10);
    assert.deepEqual(prepared.predecessorBindings, []);
    assert.deepEqual(await readFile(retainedSources.at(-1).filename), base);
    assert.equal(prepared.receipt.preparedGuard.genericNonnullEntriesEncoded, 12);
    assert.equal(prepared.receipt.preparedGuard.originalNullableOverridesPreserved, 29);
    assert.equal(prepared.receipt.preparedGuard.untouchedNonnullVoidOverrides, 3);
    for (const source of originalSources) {
        const recipes = lock.recipes.filter(recipe => recipe.path === source.path);
        if (!recipes.length) continue;
        const output = await readFile(prepared.commonSources.find(name => name.endsWith('/' + source.path)));
        let restored = output.toString();
        for (const recipe of recipes) {
            assert.equal(restored.split(recipe.prepared).length, 2);
            restored = restored.replace(recipe.prepared, recipe.original);
        }
        assert.deepEqual(Buffer.from(restored), source.source, 'Only sealed checked entries may change');
        assert.throws(() => encodeVisitorEntries(output, recipes));
    }
});

test('literal, typed and inferred nullable platform callers remain admitted', () => {
    for (const source of ['fun caller(m: DeclarationDescriptor) { m.accept(null, null) }',
        'fun caller(m: DeclarationDescriptor, v: DeclarationDescriptorVisitor<String?, String?>?) { m.accept(v, null) }',
        'fun caller(m: DeclarationDescriptor, v: DeclarationDescriptorVisitor<String?, String?>, b: Boolean) { m.accept(if(b) v else null, null) }']) {
        assert.doesNotThrow(() => inspectVisitorConsumers([...originalSources, { path: 'caller.kt', source: Buffer.from(source) }], lock.contracts));
    }
});

test('new nonnull, nullable and directly aliased visitor overrides fail the complete incoming guard', () => {
    for (const source of [
        'override fun <R,D> accept(visitor: DeclarationDescriptorVisitor<R,D>, data:D):R = visitor.visitModuleDeclaration(this,data)',
        'override fun <R,D> accept(visitor: DeclarationDescriptorVisitor<R,D>?, data:D):R? = null',
        'override fun <R,\nD> accept(v: DeclarationDescriptorVisitor<R,D>?, data:D):R? = null',
        'import org.jetbrains.kotlin.descriptors.DeclarationDescriptorVisitor as V\n' +
        'override fun <R,D> accept(visitor:V<R,D>?, data:D):R? = null',
        'typealias Hidden = DeclarationDescriptorVisitor<String?,String?>',
    ]) assert.throws(() => inspectVisitorConsumers([...originalSources, { path: 'new.kt', source: Buffer.from(source) }], lock.contracts));
});

test('changed existing nullable behavior and forced Void mapping fail the source span guard', () => {
    for (const [logical, before, after] of [
        ['compiler/fir/fir2ir/src/org/jetbrains/kotlin/fir/descriptors/FirPackageFragmentDescriptor.kt', 'visitor?.visitPackageFragmentDescriptor(this, data)', 'visitor!!.visitPackageFragmentDescriptor(this, data)'],
        ['core/descriptors/src/org/jetbrains/kotlin/types/error/ErrorModuleDescriptor.kt', 'DeclarationDescriptorVisitor<Void, Void>', 'DeclarationDescriptorVisitor<Nothing?, Nothing?>'],
    ]) {
        const changed = originalSources.map(source => source.path === logical ? { ...source, source: Buffer.from(source.source.toString().replace(before, after)) } : source);
        assert.throws(() => inspectVisitorConsumers(changed, lock.contracts));
    }
});

test('all real original override sources and one exact canonical nullable predecessor are required', async () => {
    await assert.rejects(prepareDescriptorVisitorContracts({ ...options('missing-module'), retainedSources: retainedSources.filter(pin => pin.path !== MODULE) }));
    await assert.rejects(prepareDescriptorVisitorContracts({ ...options('missing-base'), retainedSources: retainedSources.slice(0, -1) }));
    await assert.rejects(prepareDescriptorVisitorContracts({ ...options('missing-visitor'), retainedSources:
        retainedSources.filter(pin => !pin.path.endsWith('/DeclarationDescriptorVisitor.kt')) }));
    await assert.rejects(prepareDescriptorVisitorContracts({ ...options('duplicate-base'), retainedSources: [...retainedSources, retainedSources.at(-1)] }));
    const filename = path.join(root, 'same-base-copy.kt'); await writeFile(filename, await readFile(retainedSources.at(-1).filename));
    await assert.rejects(prepareDescriptorVisitorContracts({ ...options('different-base-file'),
        retainedSources: retainedSources.map(pin => pin.path === OUTPUT ? { ...pin, filename } : pin) }));
});

test('changed or fabricated canonical descriptor preparation cannot bypass full replay', async () => {
    await assert.rejects(prepareDescriptorVisitorContracts({ ...options('fabricated-predecessor'),
        preparedDescriptors: { ...preparedDescriptors, receipt: { ...preparedDescriptors.receipt, readiness: true } } }));
    const filename = retainedSources.at(-1).filename, original = await readFile(filename);
    try {
        await writeFile(filename, original.toString().replace('Visitor<R, D>?', 'Visitor<R, D>'));
        await assert.rejects(prepareDescriptorVisitorContracts(options('changed-base')));
    } finally { await writeFile(filename, original); }
});

test('different original bytes fail even with fresh selected-source hashes', async () => {
    const pin = retainedSources.find(pin => pin.path === MODULE), filename = path.join(root, 'changed-module.kt');
    const bytes = Buffer.from((await readFile(pin.filename)).toString().replace('return visitor.visitModuleDeclaration(this, data)', 'return null'));
    await writeFile(filename, bytes);
    await assert.rejects(prepareDescriptorVisitorContracts({ ...options('changed-input'),
        retainedSources: retainedSources.map(item => item.path === MODULE ? { ...item, filename, bytes: bytes.length, sha256: sha256(bytes) } : item) }));
});

test('changed entry exceptions, messages, original body or claims fail sealed replay', async () => {
    const input = options('tampering'), prepared = await prepareDescriptorVisitorContracts(input);
    const receipt = JSON.parse(await readFile(prepared.receiptPath));
    for (const change of [{ fullCompilerBuilt: true }, { languageReadiness: true },
        { originalNullableDeclarationsAndBodiesUnchanged: false }, { profile: { ...receipt.profile, voidMappingClosed: true } }, { preparedGuard: {} }]) {
        await writeFile(prepared.receiptPath, JSON.stringify({ ...receipt, ...change }));
        await assert.rejects(verifyDescriptorVisitorContracts({ ...input, profileRoot: input.outputRoot }));
    }
    await writeFile(prepared.receiptPath, JSON.stringify(receipt));
    const filename = prepared.commonSources.find(name => name.endsWith('/' + MODULE)), output = await readFile(filename);
    for (const bytes of [
        output.toString().replace('throw NullPointerException(', 'throw IllegalStateException('),
        output.toString().replace('parameter visitor', 'parameter other'),
        output.toString().replace('return visitor.visitModuleDeclaration(this, data)', 'return null'),
    ]) {
        await writeFile(filename, bytes);
        await assert.rejects(verifyDescriptorVisitorContracts({ ...input, profileRoot: input.outputRoot }));
    }
    await writeFile(filename, output);
    const reference = path.join(input.outputRoot, 'reference', MODULE), original = await readFile(reference);
    await writeFile(reference, original.toString().replace('Copyright', 'Changed'));
    await assert.rejects(verifyDescriptorVisitorContracts({ ...input, profileRoot: input.outputRoot }));
    await writeFile(reference, original);
});
