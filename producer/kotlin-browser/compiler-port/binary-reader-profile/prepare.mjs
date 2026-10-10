import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
export const READER = 'wasm/wasm.ir/src/org/jetbrains/kotlin/wasm/ir/convertors/WasmBinaryToIR.kt';
const IC_READER = 'compiler/ir/backend.wasm/src/org/jetbrains/kotlin/backend/wasm/serialization/WasmDeserializer.kt';
const NAMES = ['WasmBinaryToIR', 'MyByteReader', 'twoByteOpcodes', 'ByteReader'];
const LIMIT = 128 * 1024 * 1024;

async function input(sourceRoot) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json'));
    const lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.kind, 'official-wasm-emit-only-binary-reader-source-profile');
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    assert.equal(lock.source.treeSha, '2be662d1ae06bfcf435efbe18191ba5e1e3f035e');
    assert.equal(lock.original.path, READER);
    assert.deepEqual(lock.exportedDeclarations, NAMES);
    assert.equal(lock.languageReadiness, false);
    const closure = await readRegular(path.join(HERE, '../closure.lock.json'), 8 * 1024 * 1024);
    assert.equal(sha256(closure), lock.primaryClosureSha256);
    assert.deepEqual(JSON.parse(closure).files.find(pin => pin.path === READER), lock.primaryOriginal);
    assert.deepEqual(lock.original, Object.fromEntries(Object.entries(lock.primaryOriginal).filter(([name]) => name !== 'compile')));
    const original = verifyFile(await readRegular(path.join(sourceRoot, READER)), lock.original);
    const headers = [...original.toString('utf8').matchAll(/^(?:class|abstract class|val) (\w+)/gm)].map(match => match[1]);
    assert.deepEqual(headers, NAMES, 'Original exported reader declarations changed');
    return { lock, lockBytes, original };
}

/** Deliberately conservative: retain comments, strings, aliases and all scopes. */
export function guardBinaryReaderReferences(snapshot, original) {
    assert(Array.isArray(snapshot) && snapshot.length > 0 && snapshot.length <= 20000);
    const seen = new Set(); let readerCount = 0, size = 0;
    const expression = /\b(?:WasmBinaryToIR|MyByteReader|twoByteOpcodes|ByteReader)\b/;
    const withoutImports = text => text.replace(/^import [^\r\n]+\r?\n/gm, '')
        .replace(/(^package[^\r\n]+)\r?\n(?:[ \t]*\r?\n)+/m, '$1\n');
    for (const item of snapshot) {
        relativePath(item.path); assert(item.path.endsWith('.kt'), 'Expected a selected Kotlin input');
        assert(!seen.has(item.path), 'Duplicate retained source path'); seen.add(item.path);
        const bytes = Buffer.from(item.source, 'base64');
        assert.equal(bytes.length, item.bytes); assert.equal(sha256(bytes), item.sha256);
        size += bytes.length; assert(size <= LIMIT, 'Selected source snapshot exceeds limit');
        assert.notEqual(item.path, IC_READER, 'Incremental Wasm deserializer is selected');
        const text = bytes.toString('utf8');
        if (item.path === READER) {
            readerCount++;
            // The root composer may bind imports. No declaration or body from
            // this original file may be replaced and then silently omitted.
            assert.equal(sha256(Buffer.from(withoutImports(text))), sha256(Buffer.from(withoutImports(original.toString('utf8')))), 'Reader body changed before selection');
        } else {
            const match = expression.exec(text);
            assert(!match, 'Retained binary-reader reference in ' + item.path + ': ' + match?.[0]);
        }
    }
    assert.equal(readerCount, 1, 'The original binary reader must be selected exactly once before exclusion');
    return { inspectedKotlinInputs: snapshot.length, inspectedBytes: size, originalReaderInputs: readerCount,
        incomingReferences: [], retainedTokensIncludeCommentsAndStrings: true,
        rule: 'Reject any exported reader identifier in every other actual selected Kotlin input, including imports and aliases',
        limitation: 'Conservative lexical source-selection guard; not a resolved compiler call graph or complete Gradle variant closure' };
}

function receiptFor(input, snapshot, snapshotPin, toolHash) {
    const inventory = snapshot.map(({ path, bytes, sha256: hash }) => ({ path, bytes, sha256: hash }));
    return { schemaVersion: 1, kind: 'official-wasm-emit-only-binary-reader-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: toolHash,
        original: input.lock.original, exportedDeclarations: NAMES, referencePath: 'original/' + READER,
        selectedSourceInventory: { count: inventory.length, sha256: sha256(Buffer.from(JSON.stringify(inventory))), snapshot: snapshotPin },
        exclusionGuard: guardBinaryReaderReferences(snapshot, input.original), sourceSetExclusions: [READER],
        profile: 'Full-rebuild wasmWasi emission; no input Wasm binary or incremental Wasm cache deserialization',
        algorithmsReplaced: false, compilerSourceBuild: 'not-run for this profile', languageReadiness: false };
}

export async function prepareBinaryReaderProfile({ sourceRoot, outputRoot, retainedSources }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep), 'Output must stay under out/');
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Source/output overlap');
    await assertNoSymlink(outputRoot);
    const inputs = await input(sourceRoot);
    assert(Array.isArray(retainedSources) && retainedSources.length > 0 && retainedSources.length <= 20000);
    const snapshot = []; let totalBytes = 0;
    for (const pin of retainedSources) {
        const bytes = await readRegular(pin.filename);
        assert.equal(bytes.length, pin.bytes, 'Selected source length changed');
        assert.equal(sha256(bytes), pin.sha256, 'Selected source bytes changed');
        totalBytes += bytes.length; assert(totalBytes <= LIMIT, 'Selected source snapshot exceeds limit');
        snapshot.push({ path: pin.path, bytes: bytes.length, sha256: sha256(bytes), source: bytes.toString('base64') });
    }
    guardBinaryReaderReferences(snapshot, inputs.original);
    const root = path.join(outputRoot, 'compiler-port-binary-reader-profile');
    await mkdir(outputRoot, { recursive: true, mode: 0o700 }); await mkdir(root, { mode: 0o700 });
    const reference = path.join(root, 'original', READER);
    await mkdir(path.dirname(reference), { recursive: true, mode: 0o700 });
    await writeFile(reference, inputs.original, { flag: 'wx', mode: 0o600 });
    const snapshotBytes = gzipSync(Buffer.from(JSON.stringify(snapshot)));
    const snapshotPin = { path: 'retained-source-snapshot.json.gz', bytes: snapshotBytes.length, sha256: sha256(snapshotBytes) };
    await writeFile(path.join(root, snapshotPin.path), snapshotBytes, { flag: 'wx', mode: 0o600 });
    const receipt = receiptFor(inputs, snapshot, snapshotPin, sha256(await readRegular(fileURLToPath(import.meta.url))));
    const receiptPath = path.join(root, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { commonSources: [], sourceSetExclusions: [READER], receipt, receiptPath };
}

export async function verifyBinaryReaderProfile(root) {
    root = path.resolve(root); await assertNoSymlink(root);
    const receiptBytes = await readRegular(path.join(root, 'receipt.json')); const receipt = JSON.parse(receiptBytes);
    const inputs = await input(path.join(root, 'original'));
    const pin = receipt.selectedSourceInventory.snapshot;
    assert.equal(pin.path, 'retained-source-snapshot.json.gz');
    const bytes = await readRegular(path.join(root, pin.path), LIMIT);
    assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
    const snapshot = JSON.parse(gunzipSync(bytes, { maxOutputLength: LIMIT * 2 }));
    assert.deepEqual(receipt, receiptFor(inputs, snapshot, pin, sha256(await readRegular(fileURLToPath(import.meta.url)))), 'Binary-reader receipt changed');
    return { receipt, receiptSha256: sha256(receiptBytes), sourceSetExclusions: [READER] };
}
