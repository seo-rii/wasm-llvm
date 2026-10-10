import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, verifyFile } from '../../scripts/source.mjs';
import { ANALYZER, ANNOTATION, MARKER, PATHS, CANDIDATES, PROPERTY, splitK1Declaration, verifyHostVariant } from './transform.mjs';
import { guardK1References } from './guard.mjs';
import { prepareK1ContainerProfile, verifyK1ContainerProfile, verifyK1ContainerProfileComposition, verifyK1ContainerProfileFinal } from './prepare.mjs';
import { frozenInputs } from './check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources');
const lock = JSON.parse(await readRegular(path.join(here, 'sources.lock.json')));
const originals = new Map(await Promise.all(lock.originals.map(async pin => [pin.path, verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin.original)])));
const splitSources = new Map(PATHS.map(name => [name, splitK1Declaration(name, originals.get(name)).common]));
const guard = retainedSources => guardK1References({ originals, splitSources, retainedSources, declarations: lock.declarations });
const source = (path, text) => ({ path, source: Buffer.from(text) });

test('exact K1 split retains marker, annotation/KClass and remaining analyzer bodies', () => {
    const analyzer = originals.get(ANALYZER).toString();
    assert.equal(splitSources.get(ANALYZER).toString(), analyzer.replace(PROPERTY, ''));
    assert(splitSources.get(ANALYZER).toString().includes('abstract val defaultImportsProvider: DefaultImportsProvider'));
    assert(splitSources.get(ANALYZER).toString().includes('ModuleInfo.DependencyOnBuiltIns.LAST'));
    assert(splitSources.get(MARKER).toString().includes('interface PlatformSpecificExtension<S : PlatformSpecificExtension<S>>'));
    const annotation = splitSources.get(ANNOTATION).toString();
    assert(annotation.includes('import kotlin.reflect.KClass'));
    assert(annotation.endsWith('annotation class DefaultImplementation(val impl: KClass<*>)'));
    assert(!annotation.includes('@Target') && !annotation.includes('@Retention'));
    assert.deepEqual(guard([source('entry/BrowserCompilerPipeline.kt', 'package browser\nfun entry() = Unit\n')]).excludedPaths, [...CANDIDATES].sort());
});

test('new real consumers through explicit type, aliases, wildcards and reflection literals are rejected', () => {
    for (const text of [
        'package unknown\nimport org.jetbrains.kotlin.container.StorageComponentContainer\nfun consumer(c: StorageComponentContainer) = c\n',
        'package unknown\nimport org.jetbrains.kotlin.container.StorageComponentContainer as C\nfun consumer(c: C) = c\n',
        'package unknown\nimport org.jetbrains.kotlin.container.*\nfun consumer() = composeContainer("x") {}\n',
        'package org.jetbrains.kotlin.container\nfun consumer(c: ComponentProvider) = c\n',
        'package unknown\nval name = "org.jetbrains.kotlin.container.ComponentProvider"\n',
        'package unknown\n// org.jetbrains.kotlin.container.ComponentProvider\n',
        'package unknown\nfun f() = org.jetbrains.kotlin.container.composeContainer("x") {}\n',
    ]) assert.throws(() => guard([source('new/Consumer.kt', text)]), /K1 DI incoming reference/);
});

test('entry uses of split reflection resolver and inferred analyzer member are rejected', () => {
    assert.throws(() => guard([source('entry/BrowserCompilerPipeline.kt', 'package unknown\nimport org.jetbrains.kotlin.container.PlatformExtensionsClashResolver as Resolver\nval r: Resolver<*>? = null\n')]), /resolver still referenced/);
    assert.throws(() => guard([source('entry/BrowserCompilerPipeline.kt', 'package unknown\nfun consumer(services: Any) = services.platformConfigurator\n')]), /analyzer member referenced/);
});

test('duplicate logical input and repeat declaration transforms are rejected', () => {
    assert.throws(() => guard([source('new/A.kt', 'package a'), source('new/A.kt', 'package b')]), /Duplicate selected logical source/);
    for (const name of PATHS) assert.throws(() => splitK1Declaration(name, splitSources.get(name)), /span changed|boundary changed/);
});

test('known host property imports preserve exact bodies; changed bodies or arbitrary imports fail closed', () => {
    const original = originals.get(ANALYZER).toString();
    const add = text => text.replace('package org.jetbrains.kotlin.resolve\n', 'package org.jetbrains.kotlin.resolve\nimport org.jetbrains.kotlin.portable.common.*\nimport org.jetbrains.kotlin.portable.descriptors.*\n\n');
    assert.equal(verifyHostVariant(Buffer.from(add(original)), Buffer.from(original)).length, 2);
    assert.throws(() => verifyHostVariant(Buffer.from(add(original).replace('DependencyOnBuiltIns.LAST', 'DependencyOnBuiltIns.NONE')), Buffer.from(original)), /declaration\/body/);
    assert.throws(() => verifyHostVariant(Buffer.from(add(original).replace('import org.jetbrains.kotlin.portable.common.*', 'import unknown.shim.*')), Buffer.from(original)), /Unreviewed host import/);
    const unknownAst = Buffer.from(add(original).replace('import org.jetbrains.kotlin.portable.common.*', 'import org.jetbrains.kotlin.js.backend.ast.JsExport'));
    assert.throws(() => verifyHostVariant(unknownAst, Buffer.from(original), lock.hostPropertyImports.approvedImports), /Unreviewed host import/);
});

let fixturePromise;
async function fixture() {
    if (!fixturePromise) fixturePromise = (async () => {
        const parent = path.join(repository, 'out/kotlin-k1-container-guards'); await mkdir(parent, { recursive: true });
        const root = await mkdtemp(path.join(parent, 'run-')); const frozen = await frozenInputs();
        const prepared = await prepareK1ContainerProfile({ sourceRoot, outputRoot: path.join(root, 'profile'), retainedSources: frozen.retainedSources });
        await verifyK1ContainerProfile(path.join(root, 'profile'));
        const finalSources = frozen.retainedSources.filter(pin => !CANDIDATES.includes(pin.path)).map(pin => {
            const replacement = prepared.receipt.files.find(item => item.path === pin.path);
            return replacement ? { ...replacement, filename: prepared.commonSources.find(name => name.endsWith('/' + pin.path)) } : pin;
        });
        return { root, frozen, prepared, finalSources };
    })();
    return fixturePromise;
}

test('complete primary and exited actual compiler source snapshots replay; final selection retains non-K1 contracts', async () => {
    const input = await fixture(); const final = await verifyK1ContainerProfileComposition({ profileRoot: path.join(input.root, 'profile'), retainedSources: input.finalSources });
    assert.equal(input.prepared.receipt.primaryInventory.count, 3417);
    assert.equal(input.prepared.receipt.composedInventory.count, 3445);
    assert.equal(final.receipt.inventory.count, 3434);
    assert.deepEqual(final.receipt.guard.excludedPaths, [...CANDIDATES].sort());
    await verifyK1ContainerProfileFinal(path.join(input.root, 'profile'));
});

test('a new actual compiler entry consumer blocks preparation before output', async () => {
    const input = await fixture(); const filename = path.join(input.root, 'FutureEntry.kt');
    const bytes = Buffer.from('package future\nfun entry(services: Any) = services.platformConfigurator\n'); await writeFile(filename, bytes);
    await assert.rejects(prepareK1ContainerProfile({ sourceRoot, outputRoot: path.join(input.root, 'rejected'),
        retainedSources: [...input.frozen.retainedSources, { path: 'future/FutureEntry.kt', filename, bytes: bytes.length, sha256: sha256(bytes) }] }), /analyzer member referenced/);
});

test('changed actual input hash is rejected before output', async () => {
    const input = await fixture(); const filename = path.join(input.root, 'WrongHash.kt'), bytes = Buffer.from('package future\n'); await writeFile(filename, bytes);
    await assert.rejects(prepareK1ContainerProfile({ sourceRoot, outputRoot: path.join(input.root, 'changed'),
        retainedSources: [...input.frozen.retainedSources, { path: 'future/WrongHash.kt', filename, bytes: bytes.length, sha256: '0'.repeat(64) }] }), /Actual selected input bytes changed/);
});

test('final all-input guard rejects new consumers and omitted ModuleInfo', async () => {
    const input = await fixture(); const filename = path.join(input.root, 'FinalConsumer.kt');
    const bytes = Buffer.from('package future\nimport org.jetbrains.kotlin.container.ComponentProvider\n'); await writeFile(filename, bytes);
    await assert.rejects(verifyK1ContainerProfileComposition({ profileRoot: path.join(input.root, 'profile'),
        retainedSources: [...input.finalSources, { path: 'future/FinalConsumer.kt', filename, bytes: bytes.length, sha256: sha256(bytes) }] }), /K1 DI incoming reference/);
    await assert.rejects(verifyK1ContainerProfileComposition({ profileRoot: path.join(input.root, 'profile'),
        retainedSources: input.finalSources.filter(pin => !pin.path.endsWith('/analyzer/ModuleInfo.kt')) }), /Required non-K1 contract removed/);
});

test('tampered preparation and final receipts cannot survive replay', async () => {
    const input = await fixture(); const finalPath = path.join(input.root, 'profile/final-composition.json');
    const final = JSON.parse(await readRegular(finalPath)); final.guard.inspectedKotlinInputs++; await writeFile(finalPath, JSON.stringify(final));
    await assert.rejects(verifyK1ContainerProfileFinal(path.join(input.root, 'profile')), /Final K1 composition receipt changed/);
    const receiptPath = input.prepared.receiptPath; const receipt = JSON.parse(await readRegular(receiptPath)); receipt.sourceSetExclusions.push('compiler/frontend.common/src/org/jetbrains/kotlin/analyzer/ModuleInfo.kt');
    await writeFile(receiptPath, JSON.stringify(receipt)); await assert.rejects(verifyK1ContainerProfile(path.join(input.root, 'profile')));
});
