import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before, after } from 'node:test';
import { prepareDescriptorContracts } from '../descriptors/prepare.mjs';
import { prepareDescriptorVisitorContracts } from '../descriptor-visitor-contract/prepare.mjs';
import { prepareVisitorVoidProfile, verifyVisitorVoidProfile } from './prepare.mjs';
import { inspectVoidProfile, mapVisitorVoid } from './transform.mjs';
import { sha256 } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const lock = JSON.parse(await readFile(path.join(HERE, 'sources.lock.json'))), prior = JSON.parse(await readFile(path.join(HERE, '../descriptor-visitor-contract/sources.lock.json')));
let root, preparedDescriptors, descriptorVisitorComponent, retainedSources, incoming;
before(async () => {
    root = await mkdtemp(path.join(REPO, 'out/visitor-Void-guards-'));
    preparedDescriptors = await prepareDescriptorContracts(sourceRoot, path.join(root, 'descriptors'));
    const canonical = prior.originals.map(pin => ({ path: pin.path, filename: path.join(sourceRoot, pin.path), bytes: pin.bytes, sha256: pin.sha256 }));
    for (const name of ['DeclarationDescriptor.kt', 'DeclarationDescriptorVisitor.kt']) {
        const pin = preparedDescriptors.receipt.files.find(item => item.path === name);
        canonical.push({ path: 'compiler-port-descriptors/generated/' + name, filename: pin.absolutePath, bytes: pin.bytes, sha256: pin.sha256 });
    }
    descriptorVisitorComponent = await prepareDescriptorVisitorContracts({ sourceRoot, outputRoot: path.join(root, 'visitor'), preparedDescriptors, retainedSources: canonical });
    retainedSources = canonical.map(pin => { const changed = prior.preparedOutputs.find(item => item.path === pin.path);
        return changed ? { path: pin.path, filename: path.join(root, 'visitor', pin.path), bytes: changed.bytes, sha256: changed.sha256 } : pin; });
    incoming = await Promise.all(retainedSources.map(async pin => ({ path: pin.path, source: await readFile(pin.filename) })));
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });
const options = name => ({ sourceRoot, outputRoot: path.join(root, name), preparedDescriptors, descriptorVisitorComponent, retainedSources });

test('exact 17 signatures preserve fourteen nullable bodies and checked original entries', async () => {
    const input = options('valid'), prepared = await prepareVisitorVoidProfile(input), verified = await verifyVisitorVoidProfile(input);
    assert.deepEqual(prepared.receipt, verified.receipt); assert.equal(prepared.commonSources.length, 6);
    assert.equal(prepared.predecessorBindings.length, 3); assert.equal(prepared.receipt.preparedGuard.genericVoidTokensMapped, 34);
    for (const pin of lock.inputs) {
        const source = incoming.find(item => item.path === pin.path).source, recipes = lock.recipes.filter(item => item.path === pin.path);
        assert.deepEqual(await readFile(prepared.commonSources.find(filename => filename.endsWith('/' + pin.path))), mapVisitorVoid(source, recipes));
    }
});
test('unrelated actual Void values, protocols and comments remain untouched', () => {
    const sentinel = '\nval other: ConstantValue<Void?>? = null\nval protocol = "java.lang.Void"\n// DeclarationDescriptorVisitor<Void, Void>\n';
    const item = incoming.find(item => lock.inputs.some(pin => pin.path === item.path && !pin.predecessor));
    const changed = incoming.map(row => row === item ? { ...row, source: Buffer.concat([row.source, Buffer.from(sentinel)]) } : row);
    assert.doesNotThrow(() => inspectVoidProfile(changed, lock.recipes));
    const output = mapVisitorVoid(changed.find(row => row.path === item.path).source, lock.recipes.filter(recipe => recipe.path === item.path));
    assert(output.toString().endsWith(sentinel));
});
test('unknown specialized visitor consumers and aliases cannot enter this profile', () => {
    for (const source of ['val v: DeclarationDescriptorVisitor<Void, Void>? = null',
        'val v: DeclarationDescriptorVisitor<Unit, java.lang.Void>? = null',
        'val v: DeclarationDescriptorVisitor<Nothing?, Nothing?>? = null',
        'import org.jetbrains.kotlin.descriptors.DeclarationDescriptorVisitor as V\nval v: V<Void, Void>? = null',
        'import java.lang.Void as NullOnly\nval x: NullOnly? = null',
        'typealias V = DeclarationDescriptorVisitor<Void, Void>',
        'override fun acceptVoid(visitor: DeclarationDescriptorVisitor<Void, Void>?) {}'])
        assert.throws(() => inspectVoidProfile([...incoming, { path: 'new.kt', source: Buffer.from(source) }], lock.recipes));
});
test('nullable operators, original bodies and nonnull entry messages stay sealed', () => {
    for (const recipe of lock.recipes) {
        const item = incoming.find(item => item.path === recipe.path);
        const changed = Buffer.from(item.source.toString().replace(recipe.input, recipe.input.replace('acceptVoid', 'acceptVoidChanged')));
        assert.throws(() => mapVisitorVoid(changed, lock.recipes.filter(row => row.path === recipe.path)));
        const forged = lock.recipes.filter(row => row.path === recipe.path).map(row => row === recipe ? {
            ...row, prepared: row.prepared.replace('Nothing?, Nothing?', 'Any?, Nothing?') } : row);
        assert.throws(() => mapVisitorVoid(item.source, forged), 'Rehashed recipe cannot exceed the actual selected encoding');
    }
});
test('all actual sources and canonical predecessor filenames are required', async () => {
    const missing = retainedSources.filter(pin => pin.path !== lock.inputs[0].path);
    await assert.rejects(prepareVisitorVoidProfile({ ...options('missing'), retainedSources: missing }));
    const original = retainedSources.find(pin => pin.path === lock.inputs.find(pin => pin.predecessor).path);
    const filename = path.join(root, 'copied-predecessor.kt'); await writeFile(filename, await readFile(original.filename));
    await assert.rejects(prepareVisitorVoidProfile({ ...options('different-file'), retainedSources: retainedSources.map(pin => pin === original ? { ...pin, filename } : pin) }));
    await assert.rejects(prepareVisitorVoidProfile({ ...options('duplicate'), retainedSources: [...retainedSources, retainedSources[0]] }));
});
test('full predecessor replay rejects changed unused earlier output and fabricated receipt', async () => {
    const unrelated = descriptorVisitorComponent.commonSources.find(filename => !lock.inputs.some(pin => filename.endsWith('/' + pin.path)));
    const source = await readFile(unrelated);
    try { await writeFile(unrelated, source.toString().replace('parameter visitor', 'parameter changed'));
        await assert.rejects(prepareVisitorVoidProfile(options('changed-unused-prior'))); } finally { await writeFile(unrelated, source); }
    await assert.rejects(prepareVisitorVoidProfile({ ...options('fabricated'), descriptorVisitorComponent: {
        ...descriptorVisitorComponent, receipt: { ...descriptorVisitorComponent.receipt, languageReadiness: true } } }));
});
test('prepared bodies, references and receipt readiness cannot be rehashed into acceptance', async () => {
    const input = options('tamper'), prepared = await prepareVisitorVoidProfile(input);
    const filename = prepared.commonSources.find(filename => filename.endsWith('/ErrorModuleDescriptor.kt')), source = await readFile(filename);
    for (const changed of [source.toString().replace('Nothing?, Nothing?', 'Unit, Nothing?'),
        source.toString().replace('NullPointerException', 'IllegalStateException'), source.toString().replace('parameter visitor', 'parameter other')]) {
        await writeFile(filename, changed); await assert.rejects(verifyVisitorVoidProfile(input));
    }
    await writeFile(filename, source);
    const receipt = await readFile(prepared.receiptPath);
    for (const key of ['generatedInterfacesUnchanged', 'originalVoidProtocolsOutsideSelectedVisitorTypesUnchanged']) {
        const changed = JSON.parse(receipt); changed[key] = false; await writeFile(prepared.receiptPath, JSON.stringify(changed));
        await assert.rejects(verifyVisitorVoidProfile(input));
    }
    const changed = JSON.parse(receipt); changed.languageReadiness = true; await writeFile(prepared.receiptPath, JSON.stringify(changed));
    await assert.rejects(verifyVisitorVoidProfile(input)); await writeFile(prepared.receiptPath, receipt);
    const reference = path.join(input.outputRoot, 'reference', lock.originals[0].path), original = await readFile(reference);
    await writeFile(reference, original.toString().replace('Copyright', 'Changed')); await assert.rejects(verifyVisitorVoidProfile(input));
    await writeFile(reference, original);
});
