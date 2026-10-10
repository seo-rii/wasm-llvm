import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { defaultDiagnosticDslReference, DSL_PATH, prepareDiagnosticDslReferences } from '../diagnostic-dsl/prepare.mjs';
import { transformDiagnosticContainer, transformSourceDsl } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const limit = 128 * 1024 * 1024;

async function recipe() {
    const bytes = await readRegular(path.join(here, 'sources.lock.json')); const lock = JSON.parse(bytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    const sourceFreeBytes = await readRegular(path.join(here, '../diagnostic-dsl/sources.lock.json'));
    assert.equal(sha256(sourceFreeBytes), lock.sourceFreeLockSha256); const sourceFree = JSON.parse(sourceFreeBytes);
    assert.deepEqual(lock.source, sourceFree.source); assert.deepEqual(lock.referenceFiles, sourceFree.files);
    const primaryBytes = await readRegular(path.join(here, '../closure.lock.json'), 8 * 1024 * 1024);
    assert.equal(sha256(primaryBytes), lock.primaryClosureSha256); const primary = JSON.parse(primaryBytes);
    for (const pin of lock.containers) {
        const original = primary.files.find(item => item.path === pin.path); assert(original);
        for (const key of ['path', 'bytes', 'gitBlob', 'sha256']) assert.equal(original[key], pin[key]);
    }
    return { bytes, lock, sourceFree };
}

export async function prepareDiagnosticSourceDslReferences(options) { return prepareDiagnosticDslReferences(options); }

export function guardSourceDslCallers(snapshot, lock, originalContainers) {
    assert(Array.isArray(snapshot) && snapshot.length > 0 && snapshot.length <= 20000);
    assert(originalContainers instanceof Map && originalContainers.size === lock.containers.length, 'Pinned original container bytes required');
    const seen = new Set(), callers = [], expected = new Map(lock.containers.map(pin => [pin.path, pin.diagnostics]));
    const withoutImports = text => text.replace(/^import [^\r\n]+\r?\n/gm, '')
        .replace(/(^package[^\r\n]+)\r?\n(?:[ \t]*\r?\n)+/m, '$1\n');
    let total = 0;
    for (const item of snapshot) {
        relativePath(item.path); assert(item.path.endsWith('.kt')); assert(!seen.has(item.path), 'Duplicate selected source'); seen.add(item.path);
        const bytes = Buffer.from(item.source, 'base64'); assert.equal(bytes.length, item.bytes); assert.equal(sha256(bytes), item.sha256);
        total += bytes.length; assert(total <= limit);
        const text = bytes.toString();
        const calls = [...text.matchAll(/\b(?:error|warning|strongWarning|deprecationError)[0-4]\s*(?:<|\()/g)];
        const imported = /^import org\.jetbrains\.kotlin\.diagnostics\.(?:error|warning|strongWarning|deprecationError)[0-4]\b/m.test(text);
        if (!calls.length && !imported) continue;
        assert(expected.has(item.path), 'Unexpected selected sourced diagnostic DSL caller: ' + item.path);
        const originalPin = lock.containers.find(pin => pin.path === item.path);
        const original = verifyFile(originalContainers.get(item.path), originalPin);
        const body = withoutImports(text), originalBody = withoutImports(original.toString());
        assert.equal(body, originalBody, 'Selected diagnostic container body changed: ' + item.path);
        assert.equal(calls.length, expected.get(item.path), 'Selected diagnostic delegate count changed');
        assert.equal([...text.matchAll(/\b(?:error|warning|strongWarning|deprecationError)[0-4]<PsiElement(?:, |>)/g)].length,
            calls.length, 'Selected delegate PSI metadata grammar changed');
        callers.push({ path: item.path, diagnostics: calls.length, bytes: item.bytes, sha256: item.sha256,
            originalBodySha256: sha256(Buffer.from(originalBody)), allowedPriorChanges: 'import lines and package-header newline gap only' });
    }
    assert.deepEqual(callers.map(item => [item.path, item.diagnostics]).sort(), [...expected].sort(), 'Missing retained diagnostic container');
    return { inspectedKotlinFiles: snapshot.length, inspectedBytes: total, callers, diagnostics: callers.reduce((count, item) => count + item.diagnostics, 0),
        limitation: 'Conservative lexical scan of every actual selected input; not a resolved FIR call graph' };
}

function outputs(originals, lock, sourceFree) {
    return [{ path: DSL_PATH, ...transformSourceDsl(originals[0].toString(), sourceFree) },
        ...lock.containers.map((pin, index) => ({ path: pin.path, ...transformDiagnosticContainer(originals[index + 2].toString(), pin.diagnostics) }))];
}

function makeReceipt(lockBytes, lock, sourceFree, originals, generated, snapshot, snapshotPin, tools) {
    const outputPins = generated.map(item => ({ path: 'common/' + item.path, bytes: Buffer.byteLength(item.text), sha256: sha256(Buffer.from(item.text)),
        deletions: item.deletions, bindings: item.bindings ?? [] }));
    assert.deepEqual(outputPins, lock.outputs, 'Sourced diagnostic metadata recipe changed');
    return { schemaVersion: 1, kind: 'official-psi-metadata-free-sourced-diagnostic-dsl', source: lock.source,
        sourceLockSha256: sha256(lockBytes), sourceFreeLockSha256: lock.sourceFreeLockSha256, tools,
        originalInputs: [...lock.referenceFiles, ...lock.containers],
        originalPins: [...lock.referenceFiles, ...lock.containers].map((pin, index) => ({ path: 'original/' + pin.path,
            bytes: originals[index].length, sha256: sha256(originals[index]) })), outputs: outputPins,
        sourceFreeDeclarationsIncluded: false, diagnosticBodiesChanged: false,
        metadataTypeArgumentSites: 31, metadataBindingCount: outputPins.reduce((count, item) => count + item.bindings.length, 0),
        sourceFreeDeclarationSpans: sourceFree.split.declarations,
        replacedOriginalPaths: lock.containers.map(pin => pin.path), commonPaths: generated.map(item => 'common/' + item.path),
        callerGuard: guardSourceDslCallers(snapshot, lock, new Map(lock.containers.map((pin, index) => [pin.path, originals[index + 2]]))), snapshot: snapshotPin,
        diagnosticRuntime: 'not-run', wasmRuntime: 'not-run', fullCompilerAcceptance: false, languageReadiness: false };
}

async function tools() {
    const pins = []; for (const name of ['prepare.mjs', 'transform.mjs']) { const bytes = await readRegular(path.join(here, name)); pins.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    return pins;
}

export async function prepareDiagnosticSourceDsl({ sourceRoot, referenceRoot = defaultDiagnosticDslReference, outputRoot, retainedSources } = {}) {
    sourceRoot = path.resolve(sourceRoot); referenceRoot = path.resolve(referenceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    for (const root of [sourceRoot, referenceRoot, outputRoot]) await assertNoSymlink(root);
    for (const root of [sourceRoot, referenceRoot]) assert(root !== outputRoot && !root.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(root + path.sep), 'Sourced diagnostic input/output overlap');
    const { bytes, lock, sourceFree } = await recipe(); const originals = [];
    for (const [root, pins] of [[referenceRoot, lock.referenceFiles], [sourceRoot, lock.containers]])
        for (const pin of pins) originals.push(verifyFile(await readRegular(path.join(root, pin.path), pin.bytes), pin));
    assert(Array.isArray(retainedSources) && retainedSources.length > 0 && retainedSources.length <= 20000);
    const snapshot = []; let total = 0;
    for (const pin of retainedSources) {
        const bytes = await readRegular(pin.filename); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
        total += bytes.length; assert(total <= limit);
        snapshot.push({ path: pin.path, bytes: bytes.length, sha256: sha256(bytes), source: bytes.toString('base64') });
    }
    guardSourceDslCallers(snapshot, lock, new Map(lock.containers.map((pin, index) => [pin.path, originals[index + 2]])));
    const generated = outputs(originals, lock, sourceFree);
    const root = path.join(outputRoot, 'compiler-port-diagnostic-source-dsl');
    const snapshotBytes = gzipSync(Buffer.from(JSON.stringify(snapshot)));
    const snapshotPin = { path: 'retained-source-snapshot.json.gz', bytes: snapshotBytes.length, sha256: sha256(snapshotBytes) };
    const receipt = makeReceipt(bytes, lock, sourceFree, originals, generated, snapshot, snapshotPin, await tools());
    await mkdir(outputRoot, { recursive: true, mode: 0o700 }); await mkdir(root, { mode: 0o700 });
    const allPins = [...lock.referenceFiles, ...lock.containers];
    for (const [filename, content] of [...allPins.map((pin, index) => ['original/' + pin.path, originals[index]]),
        ...generated.map(item => ['common/' + item.path, Buffer.from(item.text)])]) {
        const target = path.join(root, filename); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { flag: 'wx', mode: 0o600 });
    }
    await writeFile(path.join(root, snapshotPin.path), snapshotBytes, { flag: 'wx', mode: 0o600 });
    const receiptPath = path.join(root, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { commonSources: generated.map(item => path.join(root, 'common', item.path)),
        replacedOriginalPaths: receipt.replacedOriginalPaths, additionalOriginalPaths: [], receipt, receiptPath };
}

export async function verifyDiagnosticSourceDsl(root) {
    root = path.resolve(root); await assertNoSymlink(root);
    const receiptBytes = await readRegular(path.join(root, 'receipt.json')); const receipt = JSON.parse(receiptBytes);
    const { bytes, lock, sourceFree } = await recipe(); const originals = [];
    for (const pin of [...lock.referenceFiles, ...lock.containers]) originals.push(verifyFile(await readRegular(path.join(root, 'original', pin.path), pin.bytes), pin));
    const generated = outputs(originals, lock, sourceFree);
    for (const item of generated) assert((await readRegular(path.join(root, 'common', item.path), Buffer.byteLength(item.text))).equals(Buffer.from(item.text)));
    assert.equal(receipt.snapshot.path, 'retained-source-snapshot.json.gz');
    const snapshotBytes = await readRegular(path.join(root, receipt.snapshot.path), limit);
    assert.equal(snapshotBytes.length, receipt.snapshot.bytes); assert.equal(sha256(snapshotBytes), receipt.snapshot.sha256);
    const snapshot = JSON.parse(gunzipSync(snapshotBytes, { maxOutputLength: limit * 2 }));
    assert.deepEqual(receipt, makeReceipt(bytes, lock, sourceFree, originals, generated, snapshot, receipt.snapshot, await tools()), 'Sourced diagnostic DSL receipt changed');
    return { receipt, receiptSha256: sha256(receiptBytes) };
}
