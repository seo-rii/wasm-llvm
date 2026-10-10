import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, gitBlob, readRegular, responseBytes, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { bindSourceMapJson, JSON_SOURCE, ECMA_SOURCE } from './transform.mjs';
import { verifySourceMapTree } from './verify-tree.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const REFERENCE = path.join(REPO, 'out/kotlin-source-map-json-reference/sources');
async function lockInput() {
    const bytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(bytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'genuine-source-map-json-ecma-foundation');
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(sha256(closureBytes), lock.primaryClosureSha256); assert.deepEqual(lock.source, closure.source);
    assert.deepEqual(lock.jsTree, closure.treeSnapshots.find(pin => pin.path === 'js'));
    assert.deepEqual(lock.sources.map(pin => pin.path), [JSON_SOURCE, ECMA_SOURCE]);
    verifySourceMapTree(lock);
    for (const pin of [...lock.dependencies, ...lock.tools, ...lock.observers]) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    const ast = JSON.parse(await readRegular(path.join(HERE, '../js-ast/sources.lock.json')));
    const number = ast.portable.find(pin => pin.path.endsWith('/AstDoubleFormat.kt'));
    assert.deepEqual(lock.numberSource, number);
    assert.deepEqual(lock.sharedDependencies, [{ component: 'jsAstReceipt', path: number.outputPath,
        bytes: number.bytes, sha256: number.sha256, gitBlob: number.gitBlob }]);
    return { lock, bytes };
}
export async function prepareSourceMapJsonReferences({ sourceRoot = REFERENCE, fetcher = fetch } = {}) {
    sourceRoot = path.resolve(sourceRoot); assert(sourceRoot.startsWith(path.join(REPO, 'out') + path.sep));
    await assertNoSymlink(sourceRoot); const { lock, bytes } = await lockInput();
    for (const pin of lock.sources) {
        const filename = path.join(sourceRoot, pin.path); let original;
        try { original = await readRegular(filename, pin.bytes); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!original) {
            original = verifyFile(await responseBytes(`https://raw.githubusercontent.com/JetBrains/kotlin/${lock.source.commit}/${pin.path}`,
                pin.bytes, fetcher), pin);
            await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
            await writeFile(filename, original, { flag: 'wx', mode: 0o600 });
        }
        verifyFile(original, pin);
    }
    return { sourceRoot, supplementalOriginals: lock.sources, sourceLockSha256: sha256(bytes) };
}
async function inputs(sourceRoot) {
    const { lock, bytes } = await lockInput(), originals = [], transformed = [];
    for (const pin of lock.sources) {
        const original = verifyFile(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), pin);
        originals.push(original); const bound = bindSourceMapJson(pin.path, original);
        verifyFile(bound.bytes, lock.prepared.find(output => output.originalPath === pin.path)); transformed.push(bound);
    }
    return { lock, bytes, originals, transformed };
}
function receiptFor(i) {
    return { schemaVersion: 1, kind: 'genuine-source-map-json-ecma-preparation', source: i.lock.source,
        sourceLockSha256: sha256(i.bytes), primaryClosureSha256: i.lock.primaryClosureSha256, jsTree: i.lock.jsTree,
        preparationToolSha256: i.lock.tools.find(pin => pin.path === 'prepare.mjs').sha256, treeMembership: verifySourceMapTree(i.lock),
        originalInputs: i.lock.sources, sharedDependencies: i.lock.sharedDependencies,
        files: i.lock.prepared.map((pin, index) => ({ ...pin, changes: i.transformed[index].changes })),
        hostBinding: 'Complete genuine JSON Writer-to-Appendable/StringWriter-to-StringBuilder and pinned Java Double text; complete genuine ECMA algorithm with explicit genuine JvmInline annotation import.',
        methodsRemoved: false, originalSourceUnmodified: true, differentialValidated: false, originalIndexSectionsSupported: false,
        parserRuntimeBuilt: false, sourceMapBuilderBuilt: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareSourceMapJson({ sourceRoot = REFERENCE, outputRoot } = {}) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep));
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const i = await inputs(sourceRoot), receipt = receiptFor(i), commonSources = [];
    for (const [index, pin] of receipt.files.entries()) {
        const filename = path.join(outputRoot, pin.path); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, i.transformed[index].bytes, { flag: 'wx', mode: 0o600 }); commonSources.push(filename);
    }
    const receiptPath = path.join(outputRoot, 'source-map-json-inputs.json'); await writeJson(receiptPath, receipt);
    return { commonSources, replacedOriginalPaths: i.lock.sources.map(pin => pin.path), supplementalOriginals: i.lock.sources,
        sharedDependencies: i.lock.sharedDependencies, receipt, receiptPath };
}
export async function verifySourceMapJson({ sourceRoot = REFERENCE, outputRoot, receiptPath } = {}) {
    const i = await inputs(sourceRoot), receipt = receiptFor(i);
    for (const pin of receipt.files) verifyFile(await readRegular(path.join(outputRoot, pin.path)), pin);
    assert.deepEqual(JSON.parse(await readRegular(receiptPath)), receipt); return receipt;
}
