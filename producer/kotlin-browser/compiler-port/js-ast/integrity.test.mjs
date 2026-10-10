import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareJsAstSources, verifyJsAstPreparation } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); const REPO = path.resolve(HERE, '../../../..');
const lock = JSON.parse(await readFile(path.join(HERE, 'sources.lock.json')));
async function fixture(operation) {
    const root = await mkdtemp(path.join(REPO, 'out/kotlin-js-ast-guard-'));
    const sourceRoot = path.join(root, 'original'), outputRoot = path.join(root, 'prepared'); await mkdir(sourceRoot);
    for (const pin of [...lock.sources, ...lock.referenceDependencies]) {
        const target = path.join(sourceRoot, pin.path); await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(REPO, 'out/kotlin-compiler-port/sources', pin.path), target);
    }
    try { await operation({ root, sourceRoot, outputRoot }); }
    finally { await rm(root, { recursive: true, force: true }); }
}

test('All63 Java replacements and44 original Kotlin companions prepare and verify', async () => fixture(async options => {
    const result = await prepareJsAstSources(options); const checked = await verifyJsAstPreparation(options.outputRoot, options);
    assert.equal(result.commonSources.length, 113); assert.equal(checked.commonSources.length, 113);
    assert.deepEqual(result.replacedOriginalPaths, lock.sources.map(pin => pin.path));
    assert.equal(result.propertyAliasImports.length, 72);
    assert(result.propertyAliasImports.every(name => /^[a-zA-Z0-9_.]+$/.test(name)));
    assert.deepEqual(result.propertyAliasImports, result.receipt.propertyAliasImports);
    assert.equal(result.receipt.completeCompilerBuilt, false);
}));
test('Changed pinned Java and Kotlin originals reject before publication', async () => fixture(async options => {
    for (const language of ['java', 'kotlin']) {
        const pin = lock.sources.find(pin => pin.language === language); const filename = path.join(options.sourceRoot, pin.path);
        const bytes = await readFile(filename); await writeFile(filename, Buffer.concat([bytes, Buffer.from('\n')]));
        await assert.rejects(prepareJsAstSources(options), /Pinned source/); await writeFile(filename, bytes);
    }
}));
test('Changed actual addToStdlib dependency rejects before publication', async () => fixture(async options => {
    await writeFile(path.join(options.sourceRoot, lock.referenceDependencies[0].path), 'changed');
    await assert.rejects(prepareJsAstSources(options), /Pinned source/);
}));
test('Original-cache overlap and symlink roots reject', async () => fixture(async options => {
    for (const outputRoot of [options.sourceRoot, path.join(options.sourceRoot, 'generated')]) {
        await assert.rejects(prepareJsAstSources({ ...options, outputRoot }), /overlaps original source cache/);
    }
    const link = path.join(options.root, 'source-link'); await symlink(options.sourceRoot, link);
    await assert.rejects(prepareJsAstSources({ ...options, sourceRoot: link }), /Symlink/);
}));
test('Existing published artifacts cannot be overwritten', async () => fixture(async options => {
    await prepareJsAstSources(options); const receiptPath = path.join(options.outputRoot, 'js-ast-inputs.json');
    const bytes = await readFile(receiptPath); await assert.rejects(prepareJsAstSources(options), /EEXIST/);
    assert.deepEqual(await readFile(receiptPath), bytes);
}));
test('Changed prepared node and omitted receipt entries reject evidence verification', async () => fixture(async options => {
    await prepareJsAstSources(options); const pin = lock.portable.find(pin => pin.originalPath);
    const target = path.join(options.outputRoot, pin.outputPath), bytes = await readFile(target);
    await writeFile(target, Buffer.concat([bytes, Buffer.from('\n')]));
    await assert.rejects(verifyJsAstPreparation(options.outputRoot, options), /Pinned source/); await writeFile(target, bytes);
    const receiptPath = path.join(options.outputRoot, 'js-ast-inputs.json'); const receipt = JSON.parse(await readFile(receiptPath));
    receipt.files.pop(); await writeFile(receiptPath, JSON.stringify(receipt));
    await assert.rejects(verifyJsAstPreparation(options.outputRoot, options), { name: 'AssertionError' });
}));
test('Prepared node symlinks reject even when target bytes are correct', async () => fixture(async options => {
    await prepareJsAstSources(options); const pin = lock.portable.find(pin => pin.originalPath); const target = path.join(options.outputRoot, pin.outputPath);
    await rm(target); await symlink(path.join(HERE, pin.path), target);
    await assert.rejects(verifyJsAstPreparation(options.outputRoot, options), /Symlink/);
}));
test('Preparation-only claims and every sealed receipt identity reject tampering', async () => fixture(async options => {
    await prepareJsAstSources(options);
    const receiptPath = path.join(options.outputRoot, 'js-ast-inputs.json');
    const original = await readFile(receiptPath); const receipt = JSON.parse(original);
    const replacements = {
        schemaVersion: 2, source: { ...receipt.source, commit: '0'.repeat(40) }, primaryClosureSha256: '0'.repeat(64),
        tools: [], commonDependencies: [], characterPolicy: {}, numberBoundary: {}, licenses: [], propertyAliasImports: [],
        differentialValidated: true, languageReadiness: true, completeCompilerBuilt: true, originalSourceUnmodified: false
    };
    for (const [field, value] of Object.entries(replacements)) {
        await writeFile(receiptPath, JSON.stringify({ ...receipt, [field]: value }));
        await assert.rejects(verifyJsAstPreparation(options.outputRoot, options), { name: 'AssertionError' }, field);
    }
    const changedFiles = structuredClone(receipt.files); changedFiles[0].transformations = ['unverified'];
    await writeFile(receiptPath, JSON.stringify({ ...receipt, files: changedFiles }));
    await assert.rejects(verifyJsAstPreparation(options.outputRoot, options), { name: 'AssertionError' });
    await writeFile(receiptPath, original); await verifyJsAstPreparation(options.outputRoot, options);
}));
