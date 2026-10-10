import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
export const ORIGINAL = 'class NullValue : ConstantValue<Void?>(null) {';
export const COMMON = 'class NullValue : ConstantValue<Nothing?>(null) {';

export function bindNullConstant(original) {
    const text = original.toString('utf8');
    assert.equal(text.split(ORIGINAL).length, 2, 'Exactly one genuine null constant declaration required');
    assert(text.includes('abstract class ConstantValue<out T>(open val value: T) {'));
    assert(text.includes('override fun getType(module: ModuleDescriptor) = module.builtIns.nullableNothingType'));
    return Buffer.from(text.replace(ORIGINAL, COMMON));
}

async function inputs(sourceRoot) {
    sourceRoot = path.resolve(sourceRoot); await assertNoSymlink(sourceRoot);
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'genuine-immutable-null-constant-common-type');
    const closureBytes = await readRegular(path.join(here, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(sha256(closureBytes), lock.primaryClosureSha256); assert.deepEqual(lock.source, closure.source);
    assert.deepEqual(lock.sources.map(pin => pin.path), [
        'core/descriptors/src/org/jetbrains/kotlin/resolve/constants/constantValues.kt',
        'core/descriptors/src/org/jetbrains/kotlin/descriptors/annotations/AnnotationArgumentVisitor.java',
    ]);
    assert.equal(lock.output.path, lock.sources[0].path);
    for (const pin of lock.sources) {
        const matches = closure.files.filter(item => item.path === pin.path);
        assert.equal(matches.length, 1); assert.deepEqual(pin, matches[0]);
    }
    const original = verifyFile(await readRegular(path.join(sourceRoot, lock.sources[0].path)), lock.sources[0]);
    const visitor = verifyFile(await readRegular(path.join(sourceRoot, lock.sources[1].path)), lock.sources[1]);
    assert(visitor.includes(Buffer.from('R visitNullValue(NullValue value, D data);')));
    const common = bindNullConstant(original); verifyFile(common, lock.output);
    return { lock, lockBytes, original, visitor, common };
}

function receiptFor(input, preparationToolSha256) {
    return { schemaVersion: 1, kind: 'genuine-immutable-null-constant-preparation', source: input.lock.source,
        primaryClosureSha256: input.lock.primaryClosureSha256, sourceLockSha256: sha256(input.lockBytes), preparationToolSha256,
        originals: input.lock.sources, output: input.lock.output, replacement: { original: ORIGINAL, common: COMMON },
        invariant: 'Final NullValue initializes the covariant ConstantValue slot with null; every constructor and method body is retained',
        runtimeReflectionMutationSupported: false, fullConstantsWasmExecuted: false, fullCompilerBuilt: false, publicLanguageSupport: false };
}

export async function prepareNullConstantValue({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep));
    await assertNoSymlink(outputRoot); const input = await inputs(sourceRoot);
    const receipt = receiptFor(input, sha256(await readRegular(fileURLToPath(import.meta.url))));
    const filename = path.join(outputRoot, input.lock.output.path);
    for (const [target, bytes] of [[filename, input.common],
        [path.join(outputRoot, 'reference', input.lock.sources[0].path), input.original],
        [path.join(outputRoot, 'reference', input.lock.sources[1].path), input.visitor]]) {
        await assertNoSymlink(target); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    const receiptPath = path.join(outputRoot, 'null-constant-value-inputs.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, commonSources: [filename], replacedOriginalPaths: [input.lock.sources[0].path], receipt, receiptPath };
}

export async function verifyNullConstantValue(outputRoot) {
    outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    const input = await inputs(path.join(outputRoot, 'reference'));
    const receipt = receiptFor(input, sha256(await readRegular(fileURLToPath(import.meta.url))));
    assert.deepEqual(await readRegular(path.join(outputRoot, input.lock.output.path)), input.common);
    const receiptBytes = await readRegular(path.join(outputRoot, 'null-constant-value-inputs.json'));
    assert.deepEqual(JSON.parse(receiptBytes), receipt);
    return { receipt, receiptSha256: sha256(receiptBytes) };
}
