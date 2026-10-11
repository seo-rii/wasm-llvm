import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { lexicalReferenceView } from '../native-js-output-profile/references.mjs';
import { selectedDeclarations } from '../backend-profile/references.mjs';
import { TARGET, SYMBOLS, REQUIRED, profileJavaSession, normalizeSessionImports } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });

export function javaSessionReferences(text) {
    const decoded = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
    const joined = lexicalReferenceView(decoded).replace(/[^A-Za-z0-9_]/g, '');
    return SYMBOLS.filter(symbol => decoded.includes(symbol) || joined.includes(symbol));
}

async function configuration() {
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const closureBytes = await readRegular(path.join(here, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'wasm-fir-java-session-island-profile');
    assert.deepEqual(lock.source, closure.source); assert.equal(lock.primaryClosureSha256, sha256(closureBytes));
    assert.deepEqual(lock.target, closure.files.find(pin => pin.path === TARGET));
    assert.deepEqual(lock.symbols, SYMBOLS); assert.deepEqual(lock.requiredBoundaries, REQUIRED);
    assert.equal(lock.entry.path, REQUIRED[2]); assert.equal(lock.entry.repositoryPath, '../entry/BrowserCompiler.kt');
    assert.equal(lock.transformSha256, sha256(await readRegular(path.join(here, 'transform.mjs'))));
    assert.equal(lock.preparationToolSha256, sha256(await readRegular(fileURLToPath(import.meta.url))));
    for (const pin of lock.dependencies) assert.deepEqual(identity(await readRegular(path.join(here, pin.path))), { bytes: pin.bytes, sha256: pin.sha256 });
    assert.deepEqual(lock.allowedOriginalConsumers, closure.files.filter(pin => pin.path === 'compiler/fir/entrypoint/src/org/jetbrains/kotlin/fir/session/FirJvmSessionFactory.kt'));
    assert.equal(lock.allowedOriginalConsumers.length, 1); assert.equal(lock.allowedOriginalConsumers[0].compile, false);
    assert.deepEqual(identity(await readRegular(path.resolve(here, lock.entry.repositoryPath))), { bytes: lock.entry.bytes, sha256: lock.entry.sha256 });
    const aliases = JSON.parse(await readRegular(path.join(here, '../serializer-comment-type-names/sources.lock.json')));
    assert.deepEqual(lock.recordedPropertyImports, aliases.recordedPropertyImports);
    return { lock, lockBytes, closure };
}

async function originalAudit(sourceRoot, input) {
    const incoming = [], inventory = input.closure.files.filter(pin => ['kotlin', 'java'].includes(pin.language));
    for (let start = 0; start < inventory.length; start += 24) {
        const results = await Promise.allSettled(inventory.slice(start, start + 24).map(async pin => {
            const bytes = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin);
            if (pin.path !== TARGET && javaSessionReferences(bytes.toString()).length) return pin.path;
        }));
        for (const result of results) { if (result.status !== 'fulfilled') throw result.reason; if (result.value) incoming.push(result.value); }
    }
    assert.deepEqual(incoming, input.lock.allowedOriginalConsumers.map(pin => pin.path), 'Unexpected original Java session consumer');
    return { inspectedFiles: inventory.length, inventorySha256: sha256(Buffer.from(JSON.stringify(inventory))), incoming };
}

export function guardJavaSessionSelection(snapshot, expectedTarget, entryPin) {
    const paths = new Set(), selected = [], incoming = []; let inspectedBytes = 0;
    for (const item of snapshot) {
        relativePath(item.path); assert(item.path.endsWith('.kt') && !paths.has(item.path), 'Duplicate or non-Kotlin session input'); paths.add(item.path);
        const bytes = Buffer.from(item.source, 'base64'); assert.deepEqual(identity(bytes), { bytes: item.bytes, sha256: item.sha256 });
        inspectedBytes += bytes.length; assert(inspectedBytes <= 256 * 1024 * 1024);
        const references = javaSessionReferences(bytes.toString()); if (references.length) incoming.push({ path: item.path, symbols: references });
        if (item.path === TARGET) assert.deepEqual(bytes, expectedTarget, 'Selected common session algorithms changed');
        if (item.path === REQUIRED[2]) {
            assert.deepEqual(identity(bytes), { bytes: entryPin.bytes, sha256: entryPin.sha256 }, 'Pinned Wasm frontend entry changed');
            assert(bytes.includes(Buffer.from('FirWasmSessionFactory.WasmWasi')), 'Actual Wasm session entry required');
        }
        if (REQUIRED.includes(item.path) || item.path === TARGET) selected.push({ path: item.path, ...identity(bytes) });
    }
    assert(paths.has(TARGET) && REQUIRED.every(name => paths.has(name)), 'Required common and Wasm session boundaries missing');
    assert.deepEqual(incoming, [], 'Selected source refers to removed Java session registration');
    return { inspectedFiles: snapshot.length, inspectedBytes, incoming, boundaries: selected };
}

async function snapshot(retainedSources, forwardSources = []) {
    const rows = [...retainedSources, ...forwardSources], result = [], filenames = new Set();
    assert(rows.length > 0 && rows.length <= 20000);
    for (let start = 0; start < rows.length; start += 24) {
        const results = await Promise.allSettled(rows.slice(start, start + 24).map(async item => {
            const filename = path.resolve(item.filename); assert(!filenames.has(filename), 'Duplicate physical session input'); filenames.add(filename);
            const bytes = await readRegular(filename); assert.deepEqual(identity(bytes), { bytes: item.bytes, sha256: item.sha256 });
            return { path: item.path, filename, ...identity(bytes), source: bytes.toString('base64') };
        }));
        for (const row of results) { if (row.status !== 'fulfilled') throw row.reason; result.push(row.value); }
    }
    return result;
}

export async function prepareFirJavaSessionProfile({ sourceRoot, outputRoot, retainedSources, forwardSources = [] }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Input/output overlap');
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const input = await configuration(), original = verifyFile(await readRegular(path.join(sourceRoot, TARGET)), input.lock.target);
    const output = profileJavaSession(original, input.lock), audit = await originalAudit(sourceRoot, input);
    const selected = await snapshot(retainedSources, forwardSources), targets = selected.filter(pin => pin.path === TARGET);
    assert.equal(targets.length, 1, 'Exactly one original session source required'); assert.deepEqual(Buffer.from(targets[0].source, 'base64'), original);
    const projected = selected.map(row => row.path === TARGET ? { ...row, ...identity(output), source: output.toString('base64') } : row);
    const guard = guardJavaSessionSelection(projected, output, input.lock.entry);
    const boundaryReferences = [];
    const filename = path.join(outputRoot, TARGET), originalPath = path.join(outputRoot, 'reference', TARGET);
    for (const [destination, bytes] of [[filename, output], [originalPath, original]]) {
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }); await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    }
    for (const logical of REQUIRED.slice(0, 2)) {
        const row = selected.find(pin => pin.path === logical), bytes = Buffer.from(row.source, 'base64');
        const reference = 'reference/' + logical, destination = path.join(outputRoot, reference);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }); await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
        boundaryReferences.push({ path: logical, reference, filename: row.filename, ...identity(bytes) });
    }
    const receipt = { schemaVersion: 1, kind: 'wasm-fir-java-session-island-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: input.lock.preparationToolSha256, transformSha256: input.lock.transformSha256,
        originalAudit: audit, originalReference: 'reference/' + TARGET, inputBinding: { path: TARGET, filename: targets[0].filename, ...identity(original) },
        output: { path: TARGET, ...identity(output) }, removedDeclarations: SYMBOLS, retainedDeclarations: input.lock.retainedDeclarations,
        selection: selected.map(({ source, ...pin }) => pin), guard, boundaryReferences,
        unchangedOutsideExactJavaIslandAndUnusedImports: true, allCommonAndWasmRegistrationsPreserved: true,
        limitation: 'Conservative selected-source identifier/literal closure; no resolved FIR call graph or complete session runtime claim.',
        fullFirSessionRuntime: false, fullCompilerBuilt: false, publicLanguageSupport: false };
    const receiptPath = path.join(outputRoot, 'fir-java-session-inputs.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, commonSources: [filename], replacedOriginalPaths: [TARGET], receipt, receiptPath,
        receiptSha256: sha256(await readRegular(receiptPath)) };
}

async function replay(outputRoot, expectedReceiptSha256) {
    outputRoot = path.resolve(outputRoot); assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep)); await assertNoSymlink(outputRoot);
    const input = await configuration(), receiptBytes = await readRegular(path.join(outputRoot, 'fir-java-session-inputs.json')), receipt = JSON.parse(receiptBytes);
    assert.match(expectedReceiptSha256 ?? '', /^[0-9a-f]{64}$/, 'Original session receipt binding required');
    assert.equal(sha256(receiptBytes), expectedReceiptSha256, 'Session preparation receipt changed');
    assert.equal(receipt.kind, 'wasm-fir-java-session-island-preparation'); assert.deepEqual(receipt.source, input.lock.source);
    assert.equal(receipt.sourceLockSha256, sha256(input.lockBytes)); assert.equal(receipt.preparationToolSha256, input.lock.preparationToolSha256);
    assert.equal(receipt.transformSha256, input.lock.transformSha256); assert.deepEqual(receipt.removedDeclarations, SYMBOLS);
    const original = verifyFile(await readRegular(path.join(outputRoot, 'reference', TARGET)), input.lock.target), output = profileJavaSession(original, input.lock);
    assert.deepEqual(receipt.output, { path: TARGET, ...identity(output) });
    assert.deepEqual(receipt.retainedDeclarations, selectedDeclarations(output.toString()));
    assert.deepEqual(receipt.originalAudit.incoming, input.lock.allowedOriginalConsumers.map(pin => pin.path));
    assert.deepEqual(receipt.boundaryReferences.map(pin => pin.path), REQUIRED.slice(0, 2));
    const boundaries = new Map();
    for (const pin of receipt.boundaryReferences) {
        assert.equal(pin.reference, 'reference/' + pin.path);
        const bytes = await readRegular(path.join(outputRoot, pin.reference)); assert.deepEqual(identity(bytes), { bytes: pin.bytes, sha256: pin.sha256 });
        boundaries.set(pin.path, bytes);
    }
    return { input, receipt, receiptBytes, output, outputRoot, boundaries };
}

export async function verifyFirJavaSessionProfile({ outputRoot, expectedReceiptSha256 }) {
    const replayed = await replay(outputRoot, expectedReceiptSha256);
    assert.deepEqual(await readRegular(path.join(replayed.outputRoot, TARGET)), replayed.output, 'Profiled session output changed');
    return { receipt: replayed.receipt, receiptSha256: sha256(replayed.receiptBytes) };
}

export async function verifyFinalFirJavaSessionProfile({ outputRoot, retainedSources, recordedPropertyImports = [], expectedReceiptSha256 }) {
    const replayed = await replay(outputRoot, expectedReceiptSha256), selected = await snapshot(retainedSources);
    if (recordedPropertyImports.length) assert.deepEqual(recordedPropertyImports, replayed.input.lock.recordedPropertyImports, 'Unrecorded session property imports');
    const targets = selected.filter(pin => pin.path === TARGET); assert.equal(targets.length, 1);
    assert.equal(targets[0].filename, path.join(replayed.outputRoot, TARGET), 'Wrong session output owner');
    const bytes = normalizeSessionImports(Buffer.from(targets[0].source, 'base64'), replayed.output, recordedPropertyImports);
    for (const [logical, canonical] of replayed.boundaries) {
        const matches = selected.filter(pin => pin.path === logical); assert.equal(matches.length, 1);
        assert.equal(matches[0].filename, replayed.receipt.boundaryReferences.find(pin => pin.path === logical).filename, 'Session factory owner changed');
        assert.deepEqual(normalizeSessionImports(Buffer.from(matches[0].source, 'base64'), canonical, recordedPropertyImports), canonical, 'Common or Wasm session factory changed');
    }
    const projected = selected.map(row => row.path === TARGET ? { ...row, ...identity(bytes), source: bytes.toString('base64') } : row);
    return { schemaVersion: 1, kind: 'wasm-fir-java-session-island-final-guard', preparationReceiptSha256: sha256(replayed.receiptBytes),
        guard: guardJavaSessionSelection(projected, replayed.output, replayed.input.lock.entry), outputOwner: targets[0].filename,
        allCommonAndWasmRegistrationsPreserved: true, fullFirSessionRuntime: false, fullCompilerBuilt: false };
}
