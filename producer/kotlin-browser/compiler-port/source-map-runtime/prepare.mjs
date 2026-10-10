import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, responseBytes, sha256, gitBlob, verifyFile, writeJson } from '../../scripts/source.mjs';
import { verifySourceMapTree } from '../source-map-json/verify-tree.mjs';
import { verifySourceContentBindings } from '../js-ast-consumer-bindings/source-content/prepare.mjs';
import { ROOT, RUNTIME_PATHS, UTILS, bindRuntime, bindConsumer } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const REFERENCE = path.join(REPO, 'out/kotlin-source-map-runtime/reference');
export async function readSourceMapRuntimeLock() {
    const bytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(bytes);
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'genuine-request-source-map-runtime');
    assert.deepEqual(lock.source, closure.source); assert.equal(lock.primaryClosureSha256, sha256(closureBytes));
    assert.deepEqual(lock.jsTree, closure.treeSnapshots.find(pin => pin.path === 'js')); verifySourceMapTree(lock);
    assert.deepEqual(lock.sources.map(pin => pin.path), RUNTIME_PATHS);
    for (const pin of [...lock.tools, ...lock.observers, ...lock.dependencies, lock.runtime]) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    for (const pin of lock.referenceDependencies) assert.deepEqual(pin, closure.files.find(item => item.path === pin.path));
    for (const pin of lock.callerClosure) assert.deepEqual(pin, closure.files.find(item => item.path === pin.path));
    return { lock, bytes };
}
export async function prepareSourceMapRuntimeReferences({ sourceRoot = REFERENCE, fetcher = fetch } = {}) {
    sourceRoot = path.resolve(sourceRoot); assert(sourceRoot.startsWith(path.join(REPO, 'out') + path.sep)); await assertNoSymlink(sourceRoot);
    const { lock, bytes } = await readSourceMapRuntimeLock();
    for (const pin of lock.sources) {
        const filename = path.join(sourceRoot, pin.path); let original;
        try { original = await readRegular(filename, pin.bytes); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!original) { original = verifyFile(await responseBytes(`https://raw.githubusercontent.com/JetBrains/kotlin/${lock.source.commit}/${pin.path}`, pin.bytes, fetcher), pin);
            await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, original, { flag: 'wx', mode: 0o600 }); }
        verifyFile(original, pin);
    }
    return { sourceRoot, supplementalOriginals: lock.sources, sourceLockSha256: sha256(bytes) };
}
async function inputs({ sourceRoot, runtimeSourceRoot = REFERENCE, sourceContentComponent, retainedSources }) {
    const i = await readSourceMapRuntimeLock(), transformed = [];
    for (const pin of i.lock.sources) transformed.push(bindRuntime(pin.path, verifyFile(await readRegular(path.join(runtimeSourceRoot, pin.path)), pin)));
    const predecessorReceiptPath = path.resolve(sourceContentComponent.receiptPath), predecessorRoot = path.dirname(predecessorReceiptPath);
    assert.equal(sourceContentComponent.receiptPath, predecessorReceiptPath);
    assert.equal(predecessorReceiptPath, path.join(predecessorRoot, 'source-content-inputs.json'));
    assert(predecessorRoot.startsWith(path.join(REPO, 'out') + path.sep)); await assertNoSymlink(predecessorRoot);
    const verified = await verifySourceContentBindings({ sourceRoot, outputRoot: predecessorRoot, receiptPath: predecessorReceiptPath });
    assert.deepEqual(sourceContentComponent.receipt, verified);
    assert.deepEqual(sourceContentComponent.commonSources, verified.files.map(pin => path.join(predecessorRoot, pin.path)));
    const predecessor = verified.files.find(pin => pin.path === i.lock.predecessor.componentRelativePath); assert(predecessor);
    assert.deepEqual(predecessor, i.lock.predecessor.pin);
    const predecessorPath = path.join(predecessorRoot, predecessor.path);
    const predecessorBytes = verifyFile(await readRegular(predecessorPath), predecessor);
    const binding = { component: i.lock.predecessor.component, componentRelativePath: predecessor.path,
        filename: predecessorPath, bytes: predecessorBytes.length, sha256: sha256(predecessorBytes),
        receiptPath: predecessorReceiptPath, receiptSha256: sha256(await readRegular(predecessorReceiptPath)), sourceLockSha256: verified.sourceLockSha256 };
    transformed.push(bindConsumer(predecessorBytes));
    for (const [index, bound] of transformed.entries()) verifyFile(bound.bytes, i.lock.prepared[index]);
    const callers = [], callerSnapshot = [];
    for (const pin of i.lock.callerClosure) {
        const original = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin);
        let filename = path.resolve(path.join(sourceRoot, pin.path));
        if (i.lock.selectedCallers.includes(pin.path)) {
            const key = pin.path === UTILS ? i.lock.predecessor.componentRelativePath : pin.path;
            const selected = retainedSources.filter(item => item.path === key && item.compile !== false); assert.equal(selected.length, 1, 'Missing selected real getJsCode caller: ' + pin.path);
            verifyFile(await readRegular(selected[0].filename), pin.path === UTILS ? predecessor : pin);
            filename = path.resolve(selected[0].filename);
            assert.equal(filename, pin.path === UTILS ? predecessorPath : path.join(path.resolve(sourceRoot), pin.path)); callers.push(pin.path);
        }
        callerSnapshot.push({ path: pin.path, filename, source: original.toString('base64') });
        if (pin.path.endsWith('/JsStaticContext.kt')) assert(original.toString().includes('val backendContext: JsIrBackendContext,'));
        if (pin.path.endsWith('/LoweringContext.kt')) assert(original.toString().includes('interface LoweringContext : LoggingContext, ErrorReportingContext') && original.toString().includes('val configuration: CompilerConfiguration'));
    }
    assert.equal(callers.length, 3);
    return { ...i, transformed, callers, binding, callerSnapshot };
}
export function sourceMapRuntimeReceiptFor(i) {
    return { schemaVersion: 1, kind: 'genuine-request-source-map-runtime-preparation', source: i.lock.source,
        sourceLockSha256: sha256(i.bytes), primaryClosureSha256: i.lock.primaryClosureSha256,
        preparationToolSha256: i.lock.tools.find(pin => pin.path === 'prepare.mjs').sha256, originalInputs: i.lock.sources,
        rootedMembership: verifySourceMapTree(i.lock), callerClosure: i.lock.callerClosure, selectedCallers: i.callers,
        files: [...i.lock.prepared.map((pin, index) => ({ ...pin, changes: i.transformed[index].changes })), i.lock.runtimeOutput],
        predecessorBindings: [i.binding], callerSnapshot: (() => { const bytes = Buffer.from(JSON.stringify(i.callerSnapshot) + '\n'); return { path: 'caller-snapshot.json', bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) }; })(), sharedDependencies: i.lock.sharedDependencies,
        hostContract: 'Explicit request-owned text files and print output; SourceMap captures supplied runtime; two genuine LoweringContext context parameters use actual configuration.',
        originalSourceUnmodified: true, originalMethodsRemoved: false, originalGlobalStdoutParity: false,
        entryRuntimeInstalled: false, differentialValidated: false, fullJsAstUtilsBuilt: false, sourceMapBuilderBuilt: false, fullCompilerBuilt: false, languageReadiness: false };
}
function outputCheck(outputRoot, sourceRoot, runtimeSourceRoot) {
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    for (const input of [sourceRoot, runtimeSourceRoot]) assert(input !== outputRoot && !outputRoot.startsWith(input + path.sep) && !input.startsWith(outputRoot + path.sep));
}
export async function prepareSourceMapRuntime(options) {
    const outputRoot = path.resolve(options.outputRoot), sourceRoot = path.resolve(options.sourceRoot), runtimeSourceRoot = path.resolve(options.runtimeSourceRoot ?? REFERENCE);
    outputCheck(outputRoot, sourceRoot, runtimeSourceRoot); await assertNoSymlink(outputRoot);
    const i = await inputs({ ...options, sourceRoot, runtimeSourceRoot }), receipt = sourceMapRuntimeReceiptFor(i), commonSources = [];
    const buffers = [...i.transformed.map(bound => bound.bytes), verifyFile(await readRegular(path.join(HERE, i.lock.runtime.path)), i.lock.runtime)];
    for (const [index, pin] of receipt.files.entries()) {
        const filename = path.join(outputRoot, pin.path); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, buffers[index], { flag: 'wx', mode: 0o600 }); commonSources.push(filename);
    }
    await writeFile(path.join(outputRoot, receipt.callerSnapshot.path), Buffer.from(JSON.stringify(i.callerSnapshot) + '\n'), { flag: 'wx', mode: 0o600 });
    const receiptPath = path.join(outputRoot, 'source-map-runtime-inputs.json'); await writeJson(receiptPath, receipt);
    return { commonSources, supplementalOriginals: i.lock.sources, replacedOriginalPaths: i.lock.sources.map(pin => pin.path),
        predecessorBindings: receipt.predecessorBindings, sharedDependencies: receipt.sharedDependencies, receipt, receiptPath };
}
export async function verifySourceMapRuntime(options) {
    const outputRoot = path.resolve(options.outputRoot), sourceRoot = path.resolve(options.sourceRoot), runtimeSourceRoot = path.resolve(options.runtimeSourceRoot ?? REFERENCE);
    outputCheck(outputRoot, sourceRoot, runtimeSourceRoot); await assertNoSymlink(outputRoot);
    const i = await inputs({ ...options, sourceRoot, runtimeSourceRoot }), receipt = sourceMapRuntimeReceiptFor(i);
    verifyFile(await readRegular(path.join(outputRoot, receipt.callerSnapshot.path)), receipt.callerSnapshot);
    for (const pin of receipt.files) verifyFile(await readRegular(path.join(outputRoot, pin.path)), pin);
    assert.equal(path.resolve(options.receiptPath), path.join(outputRoot, 'source-map-runtime-inputs.json'));
    assert.deepEqual(JSON.parse(await readRegular(options.receiptPath)), receipt); return receipt;
}
