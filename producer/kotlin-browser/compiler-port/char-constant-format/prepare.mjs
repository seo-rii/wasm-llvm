import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { bindNullConstant, verifyNullConstantValue } from '../null-constant-value-profile/prepare.mjs';
import { verifyJsAstPreparation } from '../js-ast/prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const logicalPath = 'core/descriptors/src/org/jetbrains/kotlin/resolve/constants/constantValues.kt';
const originalFormat = String.raw`    override fun toString() = "\\u%04X ('%s')".format(value.code, getPrintablePart(value))`;
const commonFormat = String.raw`    override fun toString() = "\\u" + value.code.toString(16).uppercase().padStart(4, '0') + " ('" + getPrintablePart(value) + "')"`;
const categories = { UNASSIGNED: 0, LINE_SEPARATOR: 13, PARAGRAPH_SEPARATOR: 14,
    CONTROL: 15, FORMAT: 16, PRIVATE_USE: 18, SURROGATE: 19 };

export function bindCharConstant(input) {
    let text = input.toString('utf8');
    const changes = [[originalFormat, commonFormat],
        ['val t = Character.getType(c).toByte()', 'val t = org.jetbrains.kotlin.js.util.AstCharacter.getType(c)'],
        ...Object.entries(categories).map(([name, value]) => ['t != Character.' + name, 't != ' + value])];
    for (const [before, after] of changes) {
        assert.equal(text.split(before).length, 2, 'Exactly one genuine character formatting span required: ' + before);
        text = text.replace(before, after);
    }
    return { bytes: Buffer.from(text), changes };
}

export function projectCharFormatting(input) {
    const text = input.toString('utf8'), start = text.indexOf('class CharValue(value: Char) : IntegerValueConstant<Char>(value) {');
    assert(start > 0 && text.indexOf('class CharValue', start + 1) < 0);
    const first = text.indexOf('    override fun toString()', start), end = text.indexOf('\n}\n', first);
    assert(first > start && end > first);
    return Buffer.from('package org.jetbrains.kotlin.resolve.constants\n\nclass CharValue(val value: Char) {\n' + text.slice(first, end) + '\n}\n');
}

async function inputs({ sourceRoot, preparedNullConstant, preparedJsAst }) {
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'genuine-char-constant-common-format');
    const closureBytes = await readRegular(path.join(here, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(sha256(closureBytes), lock.primaryClosureSha256); assert.deepEqual(lock.source, closure.source);
    assert.deepEqual(lock.consumer, closure.files.find(pin => pin.path === logicalPath));
    assert.deepEqual(lock.excludedJdkCategories, categories);
    for (const pin of [lock.nullPredecessorLock, lock.nullPredecessorTool, lock.astLock])
        verifyFile(await readRegular(path.join(here, '..', pin.path)), pin);
    const astLock = JSON.parse(await readRegular(path.join(here, '..', lock.astLock.path)));
    assert.deepEqual(astLock.portable.find(pin => pin.path === lock.astCharacter.path), lock.astCharacter);
    assert.deepEqual(astLock.characterPolicy, lock.characterPolicy);
    verifyFile(await readRegular(path.join(here, '../js-ast', lock.characterPolicy.path)), lock.characterPolicy);
    const original = verifyFile(await readRegular(path.join(sourceRoot, logicalPath)), lock.consumer);
    assert.equal(path.resolve(preparedNullConstant.receiptPath), path.join(path.resolve(preparedNullConstant.outputRoot), 'null-constant-value-inputs.json'));
    const prior = await verifyNullConstantValue(preparedNullConstant.outputRoot);
    assert.deepEqual(prior.receipt, preparedNullConstant.receipt);
    const predecessorFile = path.join(path.resolve(preparedNullConstant.outputRoot), logicalPath);
    assert.deepEqual(preparedNullConstant.commonSources, [predecessorFile]);
    const predecessor = await readRegular(predecessorFile); assert.deepEqual(predecessor, bindNullConstant(original));
    assert.equal(path.resolve(preparedJsAst.receiptPath), path.join(path.resolve(preparedJsAst.outputRoot), 'js-ast-inputs.json'));
    const ast = await verifyJsAstPreparation(preparedJsAst.outputRoot, { sourceRoot });
    assert.deepEqual(ast.receipt, preparedJsAst.receipt); assert.deepEqual(ast.commonSources, preparedJsAst.commonSources);
    const characterFile = path.join(path.resolve(preparedJsAst.outputRoot), lock.astCharacter.outputPath);
    assert(ast.commonSources.includes(characterFile));
    verifyFile(await readRegular(characterFile), lock.astCharacter);
    const transformed = bindCharConstant(predecessor); verifyFile(transformed.bytes, lock.output);
    return { lock, lockBytes, original, predecessor, transformed,
        predecessorBinding: { component: 'nullConstantValueReceipt', componentRelativePath: logicalPath,
            filename: predecessorFile, bytes: predecessor.length, sha256: sha256(predecessor), receiptSha256: prior.receiptSha256 },
        sharedDependency: { component: 'jsAstReceipt', path: lock.astCharacter.outputPath, filename: characterFile,
            bytes: lock.astCharacter.bytes, sha256: lock.astCharacter.sha256,
            receiptSha256: sha256(await readRegular(preparedJsAst.receiptPath)) } };
}

function receiptFor(input) {
    return { schemaVersion: 1, kind: 'genuine-char-constant-format-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: null,
        consumer: input.lock.consumer, output: input.lock.output, changes: input.transformed.changes,
        predecessorBinding: input.predecessorBinding, sharedDependency: input.sharedDependency,
        characterPolicy: input.lock.characterPolicy, excludedJdkCategories: input.lock.excludedJdkCategories,
        fullConstantsWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
}

export async function prepareCharConstantFormat(options) {
    const outputRoot = path.resolve(options.outputRoot), sourceRoot = path.resolve(options.sourceRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    for (const root of [sourceRoot, options.preparedNullConstant.outputRoot, options.preparedJsAst.outputRoot]) {
        const other = path.resolve(root);
        assert(other !== outputRoot && !other.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(other + path.sep));
    }
    await assertNoSymlink(outputRoot); const input = await inputs(options), receipt = receiptFor(input);
    receipt.preparationToolSha256 = sha256(await readRegular(fileURLToPath(import.meta.url)));
    const filename = path.join(outputRoot, logicalPath);
    for (const [target, bytes] of [[filename, input.transformed.bytes], [path.join(outputRoot, 'reference', logicalPath), input.original]]) {
        await assertNoSymlink(target); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    const receiptPath = path.join(outputRoot, 'char-constant-format-inputs.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, commonSources: [filename], replacedOriginalPaths: [logicalPath],
        predecessorBindings: [input.predecessorBinding], sharedDependencies: [input.sharedDependency], receipt, receiptPath };
}

export async function verifyCharConstantFormat(options) {
    const input = await inputs(options), receipt = receiptFor(input);
    receipt.preparationToolSha256 = sha256(await readRegular(fileURLToPath(import.meta.url)));
    assert.deepEqual(await readRegular(path.join(options.outputRoot, logicalPath)), input.transformed.bytes);
    assert.deepEqual(await readRegular(path.join(options.outputRoot, 'reference', logicalPath)), input.original);
    assert.deepEqual(JSON.parse(await readRegular(path.join(options.outputRoot, 'char-constant-format-inputs.json'))), receipt);
    return receipt;
}
