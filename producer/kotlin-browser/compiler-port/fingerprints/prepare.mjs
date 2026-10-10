import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { generateFingerprints, guardDiskReaders, PATHS, splitDisk } from './generate.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const LIMIT = 256 * 1024 * 1024;

async function inputs(sourceRoot) {
    await assertNoSymlink(sourceRoot);
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
    assert.equal(lock.kind, 'official-memory-compiler-fingerprints-common-boundary'); assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775'); assert.equal(lock.languageReadiness, false);
    assert.deepEqual(lock.originals.map(pin => pin.path), PATHS);
    assert.equal(sha256(await readRegular(path.join(HERE, 'generate.mjs'))), lock.generatorSha256);
    const originals = new Map();
    for (const pin of lock.originals) originals.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, relativePath(pin.path))), pin));
    const outputs = generateFingerprints(originals);
    outputs.set('FingerprintByteBuffer.kt', await readRegular(path.join(HERE, 'FingerprintByteBuffer.kt')));
    for (const pin of lock.outputs) { const bytes = outputs.get(pin.path); assert(bytes); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); }
    assert.deepEqual(splitDisk(originals.get(PATHS[1])).declarations.map(bytes => sha256(Buffer.from(bytes))), lock.excludedDiskDeclarationSha256);
    return { lock, lockBytes, originals, outputs };
}

function receiptFor(root, input, snapshot, snapshotPin, toolHash) {
    const inventory = snapshot.map(({ path, bytes, sha256: hash }) => ({ path, bytes, sha256: hash }));
    const guard = guardDiskReaders(snapshot.map(item => ({ path: item.path, source: Buffer.from(item.source, 'base64') })));
    return { schemaVersion: 1, kind: 'official-memory-compiler-fingerprints-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: toolHash, sources: input.lock.outputs,
        selectedSourceInventory: { count: inventory.length, sha256: sha256(Buffer.from(JSON.stringify(inventory))), snapshot: snapshotPin },
        diskExclusionGuard: guard, excludedDiskDeclarationSha256: input.lock.excludedDiskDeclarationSha256,
        substitutions: input.lock.substitutions, commonSources: input.lock.outputs.map(pin => path.join(root, pin.path)),
        replacedOriginalPaths: PATHS, hashAndCombinationAlgorithmsChanged: false,
        byteOrder: 'big endian, low word first', shortInput: 'IndexOutOfBoundsException', oversizedInput: 'first 16 bytes only',
        parseBehavior: 'original mapNotNull accepts two valid base-36 segments even with invalid segments present',
        originalSourceUnmodified: true, fullCompilerBuilt: false, languageReadiness: false };
}

export async function prepareCompilerFingerprints({ sourceRoot, outputRoot, retainedSources }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep), 'Output must stay under out/');
    assert(outputRoot !== sourceRoot && !outputRoot.startsWith(sourceRoot + path.sep) && !sourceRoot.startsWith(outputRoot + path.sep), 'Output overlaps original source cache');
    await assertNoSymlink(outputRoot); const input = await inputs(sourceRoot);
    assert(Array.isArray(retainedSources) && retainedSources.length > 0 && retainedSources.length <= 20000);
    const seen = new Set(); const snapshot = []; let size = 0;
    for (const pin of retainedSources) {
        relativePath(pin.path); assert(!seen.has(pin.path), 'Duplicate retained path'); seen.add(pin.path);
        const bytes = await readRegular(pin.filename); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
        size += bytes.length; assert(size <= LIMIT, 'Retained source snapshot exceeds limit');
        snapshot.push({ path: pin.path, bytes: bytes.length, sha256: sha256(bytes), source: bytes.toString('base64') });
    }
    guardDiskReaders(snapshot.map(item => ({ path: item.path, source: Buffer.from(item.source, 'base64') })));
    const root = path.join(outputRoot, 'compiler-port-fingerprints'); await mkdir(outputRoot, { recursive: true, mode: 0o700 }); await mkdir(root, { mode: 0o700 });
    for (const [logical, bytes] of input.outputs) {
        const filename = path.join(root, relativePath(logical)); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    }
    for (const [logical, bytes] of input.originals) {
        const filename = path.join(root, 'original', relativePath(logical)); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    }
    const snapshotBytes = gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 6 });
    const snapshotPin = { path: 'retained-source-snapshot.json.gz', bytes: snapshotBytes.length, sha256: sha256(snapshotBytes) };
    await writeFile(path.join(root, snapshotPin.path), snapshotBytes, { flag: 'wx', mode: 0o600 });
    const receipt = receiptFor(root, input, snapshot, snapshotPin, sha256(await readRegular(fileURLToPath(import.meta.url))));
    const receiptPath = path.join(root, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { commonSources: receipt.commonSources, replacedOriginalPaths: PATHS, receipt, receiptPath };
}

export async function verifyCompilerFingerprints(root) {
    root = path.resolve(root); await assertNoSymlink(root);
    const receiptBytes = await readRegular(path.join(root, 'receipt.json')); const receipt = JSON.parse(receiptBytes);
    const input = await inputs(path.join(root, 'original')); const pin = receipt.selectedSourceInventory.snapshot;
    assert.equal(pin.path, 'retained-source-snapshot.json.gz'); const compressed = await readRegular(path.join(root, pin.path), LIMIT);
    assert.equal(compressed.length, pin.bytes); assert.equal(sha256(compressed), pin.sha256);
    const snapshot = JSON.parse(gunzipSync(compressed, { maxOutputLength: LIMIT * 2 })); assert(Array.isArray(snapshot) && snapshot.length <= 20000);
    const seen = new Set();
    for (const item of snapshot) {
        relativePath(item.path); assert(!seen.has(item.path)); seen.add(item.path);
        const source = Buffer.from(item.source, 'base64'); assert.equal(source.length, item.bytes); assert.equal(sha256(source), item.sha256);
    }
    assert.deepEqual(receipt, receiptFor(root, input, snapshot, pin, sha256(await readRegular(fileURLToPath(import.meta.url)))));
    for (const [logical, bytes] of input.outputs) assert.deepEqual(await readRegular(path.join(root, logical)), bytes);
    return { receipt, receiptSha256: sha256(receiptBytes), commonSources: receipt.commonSources, replacedOriginalPaths: PATHS };
}
