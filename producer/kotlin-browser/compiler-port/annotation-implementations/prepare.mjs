import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
async function inputs(sourceRoot) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(lock.kind, 'genuine-annotation-implementation-carriers');
    assert.deepEqual(lock.source, closure.source); assert.equal(lock.primaryClosureSha256, sha256(closureBytes));
    for (const pin of lock.tools) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    const originals = [];
    for (const pin of lock.originals) {
        assert.deepEqual(pin, closure.files.find(item => item.path === pin.path));
        originals.push(verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin));
    }
    const common = verifyFile(await readRegular(path.join(HERE, lock.common.path)), lock.common);
    return { lock, lockBytes, originals, common };
}
function receiptFor(input) {
    return { schemaVersion: 1, kind: 'genuine-annotation-implementations-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), originals: input.lock.originals,
        file: { ...input.lock.common, path: input.lock.outputPath },
        implementationClasses: ['AnnotatedImpl', 'AnnotationDescriptorImpl'],
        contract: 'Declared nonnull constructor inputs; original virtual getters, reference aliasing, interface fqName and renderer delegation.',
        rawJavaNullConstructionParity: false, reflectionFieldLayoutParity: false,
        fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareAnnotationImplementations({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot);
    outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    assert(outputRoot !== sourceRoot && !outputRoot.startsWith(sourceRoot + path.sep) && !sourceRoot.startsWith(outputRoot + path.sep), 'Source/output overlap');
    const input = await inputs(sourceRoot), receipt = receiptFor(input);
    for (const [index, pin] of input.lock.originals.entries()) {
        const filename = path.join(outputRoot, 'reference', pin.path);
        await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, input.originals[index], { flag: 'wx', mode: 0o600 });
    }
    const filename = path.join(outputRoot, input.lock.outputPath);
    await assertNoSymlink(filename);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, input.common, { flag: 'wx', mode: 0o600 });
    const receiptPath = path.join(outputRoot, 'annotation-implementations-inputs.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, commonSources: [filename], replacedOriginalPaths: input.lock.originals.filter(pin => pin.language === 'java').map(pin => pin.path), receipt, receiptPath };
}
export async function verifyAnnotationImplementations(outputRoot) {
    outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    const input = await inputs(path.join(outputRoot, 'reference')), receipt = receiptFor(input);
    assert.deepEqual(JSON.parse(await readRegular(path.join(outputRoot, 'annotation-implementations-inputs.json'))), receipt);
    verifyFile(await readRegular(path.join(outputRoot, input.lock.outputPath)), input.lock.common);
    return receipt;
}
