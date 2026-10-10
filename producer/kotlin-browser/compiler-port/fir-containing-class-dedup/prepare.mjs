import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { DECLARATION, PROVIDER, RESOLVE, deduplicateContainingClass } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..'), limit = 256 * 1024 * 1024;
const algorithm = text => text.replace(/^import [^\r\n]+\r?\n/gm, '').replace(/^(package[^\r\n]+\r?\n)\s*\n/m, '$1');

export function assertPrimaryContainingClassPins(lock, primaryBytes) {
    const primary = JSON.parse(primaryBytes);
    assert.equal(sha256(primaryBytes), lock.primaryClosureSha256); assert.deepEqual(lock.source, primary.source);
    assert.equal(lock.sources.length, 2); assert.equal(lock.references.length, 2);
    assert.equal(new Set([...lock.sources, ...lock.references].map(pin => pin.path)).size, 4);
    for (const pin of [...lock.sources, ...lock.references]) {
        const matches = primary.files.filter(item => item.path === pin.path); assert.equal(matches.length, 1); assert.deepEqual(pin, matches[0]);
    }
}

async function inputs(sourceRoot) {
    sourceRoot = path.resolve(sourceRoot); await assertNoSymlink(sourceRoot);
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'official-fir-containing-class-flattened-declaration-dedup');
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    assertPrimaryContainingClassPins(lock, await readRegular(path.join(here, '../closure.lock.json')));
    assert.equal(sha256(await readRegular(path.join(here, 'transform.mjs'))), lock.transformSha256);
    const originals = new Map();
    for (const pin of [...lock.sources, ...lock.references]) originals.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin));
    assert(originals.get(lock.references[1].path).includes(Buffer.from('api(project(":compiler:fir:providers"))')));
    return { lockBytes, lock, originals };
}

export function guardContainingClassDeclarations(snapshot, originals, { final = false } = {}) {
    assert(Array.isArray(snapshot) && snapshot.length > 0 && snapshot.length <= 20000);
    const seen = new Set(), declarations = [], imports = [], callSites = [], selected = []; let total = 0;
    for (const item of snapshot) {
        relativePath(item.path); assert(!seen.has(item.path)); seen.add(item.path); assert(item.path.endsWith('.kt'));
        const bytes = Buffer.from(item.source, 'base64'); assert.equal(bytes.length, item.bytes); assert.equal(sha256(bytes), item.sha256);
        total += bytes.length; assert(total <= limit); const text = bytes.toString();
        assert(!/\bResolveUtilsKt\s*(?:\.|::)\s*getContainingClass\b/.test(text), 'Direct removed JVM facade method consumer: ' + item.path);
        assert(!/^import[^\r\n]*\bResolveUtilsKt\b[^\r\n]*\bgetContainingClass\b/m.test(text), 'Direct JVM facade import');
        if (item.path === PROVIDER || item.path === RESOLVE) {
            let expected = originals.get(item.path).toString();
            if (final && item.path === RESOLVE) expected = expected.replace(DECLARATION, '');
            assert.equal(algorithm(text), algorithm(expected), 'Selected containing-class algorithm changed: ' + item.path);
            selected.push({ path: item.path, bytes: item.bytes, sha256: item.sha256, originalSha256: sha256(originals.get(item.path)) });
        }
        const matches = [...text.matchAll(/\bfun\s+FirCallableDeclaration\s*\.\s*getContainingClass\s*\(/g)];
        if (matches.length) {
            assert(item.path === PROVIDER || (!final && item.path === RESOLVE), 'Unknown exported receiver declaration: ' + item.path);
            assert.equal(matches.length, 1); assert.equal(text.split(DECLARATION).length, 2, 'Receiver algorithm or nullability changed');
            declarations.push({ path: item.path, declarationSha256: sha256(Buffer.from(DECLARATION)) });
        }
        const lines = text.split('\n');
        for (let index = 0; index < lines.length; index++) {
            if (/^import\s+[^\r\n]*\bgetContainingClass(?:\s+as\s+\w+)?\s*$/.test(lines[index])) {
                assert(/^import org\.jetbrains\.kotlin\.(?:fir\.resolve|resolve\.DescriptorUtils(?:\.Companion)?)\.getContainingClass(?:\s+as\s+\w+)?\s*$/.test(lines[index]), 'Unknown same-name imported helper');
                imports.push({ path: item.path, line: index + 1, statement: lines[index] });
            }
            if (/\bgetContainingClass\s*\(/.test(lines[index])) callSites.push({ path: item.path, line: index + 1, statement: lines[index].trim() });
        }
    }
    assert.deepEqual(selected.map(item => item.path).sort(), [PROVIDER, RESOLVE].sort(), 'Both selected original modules required');
    assert.deepEqual(declarations.map(item => item.path).sort(), (final ? [PROVIDER] : [PROVIDER, RESOLVE]).sort());
    return { inspectedFiles: snapshot.length, inspectedBytes: total, selected, declarations, imports, callSites,
        directJvmFacadeConsumers: [], publicReceiverPreserved: true, limitation: 'Conservative lexical selected-source guard, not resolved FIR call-graph analysis' };
}

async function snapshotSources(retainedSources) {
    const snapshot = [];
    for (const pin of retainedSources) {
        const bytes = await readRegular(pin.filename); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
        snapshot.push({ path: pin.path, bytes: bytes.length, sha256: sha256(bytes), source: bytes.toString('base64') });
    }
    return snapshot;
}

function receiptFor(input, transformed, snapshotPin, guard, prepareSha256) {
    return { schemaVersion: 1, kind: 'official-fir-containing-class-dedup-preparation', source: input.lock.source,
        primaryClosureSha256: input.lock.primaryClosureSha256, sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: prepareSha256, transformSha256: input.lock.transformSha256,
        sources: input.lock.sources, references: input.lock.references, output: input.lock.output, snapshot: snapshotPin, guard,
        removedSpan: transformed.removedSpan, retainedDeclaration: transformed.retainedDeclaration,
        replacedOriginalPaths: [RESOLVE], publicReceiver: 'org.jetbrains.kotlin.fir.resolve.getContainingClass(FirCallableDeclaration)',
        moduleFlatteningOnly: true, otherAlgorithmsChanged: false, fullFirWasmRuntime: false, fullCompilerBuilt: false, publicLanguageSupport: false };
}

export async function prepareContainingClassDedup({ sourceRoot, outputRoot, retainedSources }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Input/output overlap');
    const input = await inputs(sourceRoot), transformed = deduplicateContainingClass(input.originals, input.lock);
    const snapshot = await snapshotSources(retainedSources), guard = guardContainingClassDeclarations(snapshot, input.originals);
    await assertNoSymlink(outputRoot); await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    async function publish(relative, bytes) { const filename = path.join(outputRoot, relative); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename; }
    for (const [logical, bytes] of input.originals) await publish('reference/' + logical, bytes);
    const snapshotBytes = gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 6 });
    const snapshotPin = { path: 'selected-source-snapshot.json.gz', bytes: snapshotBytes.length, sha256: sha256(snapshotBytes) };
    await publish(snapshotPin.path, snapshotBytes); const filename = await publish(RESOLVE, transformed.bytes);
    const receipt = receiptFor(input, transformed, snapshotPin, guard, sha256(await readRegular(fileURLToPath(import.meta.url))));
    const receiptPath = path.join(outputRoot, 'containing-class-dedup-inputs.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, commonSources: [filename], replacedOriginalPaths: [RESOLVE], receipt, receiptPath };
}

async function replayPreparation(root) {
    root = path.resolve(root); await assertNoSymlink(root); assert(root.startsWith(path.join(repository, 'out') + path.sep));
    const input = await inputs(path.join(root, 'reference')), receiptBytes = await readRegular(path.join(root, 'containing-class-dedup-inputs.json')), receipt = JSON.parse(receiptBytes);
    assert.equal(receipt.snapshot.path, 'selected-source-snapshot.json.gz'); const packed = await readRegular(path.join(root, receipt.snapshot.path), limit);
    assert.equal(packed.length, receipt.snapshot.bytes); assert.equal(sha256(packed), receipt.snapshot.sha256);
    const snapshot = JSON.parse(gunzipSync(packed, { maxOutputLength: limit })), guard = guardContainingClassDeclarations(snapshot, input.originals);
    const transformed = deduplicateContainingClass(input.originals, input.lock);
    assert.deepEqual(receipt, receiptFor(input, transformed, receipt.snapshot, guard, sha256(await readRegular(fileURLToPath(import.meta.url)))));
    return { receipt, receiptSha256: sha256(receiptBytes), input, transformed };
}

export async function verifyContainingClassDedup(root) {
    const replayed = await replayPreparation(root);
    assert.deepEqual(await readRegular(path.join(root, RESOLVE)), replayed.transformed.bytes);
    return { receipt: replayed.receipt, receiptSha256: replayed.receiptSha256 };
}

export async function verifyFinalContainingClassDedup({ profileRoot, retainedSources, allowedAddedImports = [] }) {
    const replayed = await replayPreparation(profileRoot), snapshot = await snapshotSources(retainedSources);
    const guard = guardContainingClassDeclarations(snapshot, replayed.input.originals, { final: true });
    for (const logical of [PROVIDER, RESOLVE]) {
        const canonical = logical === PROVIDER ? replayed.input.originals.get(logical) : replayed.transformed.bytes;
        const actual = snapshot.find(item => item.path === logical); assert(actual);
        const imports = text => [...text.matchAll(/^import ([^\r\n]+)\r?\n/gm)].map(match => match[1]);
        const expected = imports(canonical.toString()), observed = imports(Buffer.from(actual.source, 'base64').toString());
        assert.equal(new Set(observed).size, observed.length, 'Duplicate final imports');
        for (const item of expected) assert(observed.includes(item), 'Canonical import removed');
        for (const item of observed) assert(expected.includes(item) || allowedAddedImports.includes(item), 'Unknown final import added');
    }
    const selected = retainedSources.filter(item => item.path === RESOLVE); assert.equal(selected.length, 1);
    assert.equal(path.resolve(selected[0].filename), path.join(path.resolve(profileRoot), RESOLVE), 'Final compiled source must be the prepared replacement');
    return { schemaVersion: 1, kind: 'official-fir-containing-class-final-selection-guard', preparationReceiptSha256: replayed.receiptSha256,
        guard, removedDuplicateOnly: true, fullCompilerBuilt: false, publicLanguageSupport: false };
}
