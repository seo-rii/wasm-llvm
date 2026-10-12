import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { normalizeImports } from '../klib-signature-index/transform.mjs';
import { selectedDeclarations } from '../backend-profile/references.mjs';
import { lexicalReferenceView } from '../native-js-output-profile/references.mjs';
import { TARGETS, REGISTRIES, SYMBOLS, BOUNDARIES, HOST, PARSER, ENTRY, checkerReferences, checkerChanges, applyCheckerChanges } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
function outputPath(filename) { assert(path.isAbsolute(filename) && filename.startsWith(path.join(REPO, 'out') + path.sep), 'Semantic checker owner must stay under out/'); }
function checked(bytes, pin, reason = 'Semantic checker bytes changed: ' + pin.path) {
    assert.deepEqual(identity(bytes), { bytes: pin.bytes, sha256: pin.sha256 }, reason); return bytes;
}
async function inputs() {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const primaryBytes = await readRegular(path.join(HERE, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'official-fir-lighttree-semantic-checker-profile');
    assert.deepEqual(lock.source, primary.source); assert.equal(lock.primaryClosureSha256, sha256(primaryBytes));
    assert.deepEqual(lock.targets.map(r => r.path), TARGETS); assert.deepEqual(lock.registries.map(r => r.path), REGISTRIES);
    assert.deepEqual(lock.symbols, SYMBOLS); assert.deepEqual(lock.boundaries.map(r => r.path), BOUNDARIES);
    for (const pin of [...lock.targets, ...lock.registries]) assert.deepEqual(pin, primary.files.find(r => r.path === pin.path));
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    assert.deepEqual(lock.recordedPropertyImports, JSON.parse(await readRegular(path.join(HERE, '../serializer-comment-type-names/sources.lock.json'))).recordedPropertyImports);
    return { lockBytes, lock, primary };
}
function canonical(bytes, input) { return normalizeImports(bytes, input.lock.recordedPropertyImports); }
async function originals(root, input) {
    const result = new Map();
    for (const pin of [...input.lock.targets, ...input.lock.registries]) {
        const bytes = verifyFile(await readRegular(path.join(root, pin.path)), pin); result.set(pin.path, bytes);
        if (TARGETS.includes(pin.path)) {
            assert.deepEqual(selectedDeclarations(bytes.toString()), input.lock.originalDeclarations[pin.path]);
            assert.deepEqual(checkerChanges(pin.path, bytes), input.lock.changes[pin.path]);
            const transformed = applyCheckerChanges(bytes, input.lock.changes[pin.path]);
            checked(transformed, input.lock.outputs.find(r => r.path === pin.path));
            assert.deepEqual(applyCheckerChanges(transformed, input.lock.changes[pin.path], true), bytes);
            assert.deepEqual(selectedDeclarations(transformed.toString()), input.lock.outputDeclarations[pin.path]);
        }
    }
    return result;
}
async function primaryAudit(sourceRoot, input) {
    const pins = input.primary.files.filter(r => ['kotlin', 'java'].includes(r.language)), references = [];
    for (let n = 0; n < pins.length; n += 24) {
        const batch = await Promise.allSettled(pins.slice(n, n + 24).map(async pin => ({ pin, bytes: verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin) })));
        for (const result of batch) {
            if (result.status !== 'fulfilled') throw result.reason;
            const { pin, bytes } = result.value, names = checkerReferences(bytes.toString());
            if (names.length) references.push({ path: pin.path, names });
        }
    }
    assert.deepEqual(references, input.lock.primaryReferences, 'Primary semantic checker declaration/registration closure changed');
    return { inspectedFiles: pins.length, inventorySha256: sha256(Buffer.from(JSON.stringify(pins))), references };
}
async function selection(rows, input, original, phase) {
    assert(Array.isArray(rows) && rows.length > 0 && rows.length <= 20000);
    const required = new Set([...TARGETS, ...BOUNDARIES]), sources = [], references = [], boundaries = [], seen = new Set(), owners = new Set(); let total = 0;
    for (let n = 0; n < rows.length; n += 24) {
        const batch = await Promise.allSettled(rows.slice(n, n + 24).map(async row => {
            assert(row.compile !== false, 'Semantic checker selection requires active compiler inputs');
            assert.deepEqual(JSON.parse(JSON.stringify(row)), row, 'Semantic checker selection requires complete JSON-compatible metadata');
            relativePath(row.path); assert(row.path.endsWith('.kt')); outputPath(row.filename);
            return { row, bytes: await readRegular(row.filename) };
        }));
        for (const result of batch) {
            if (result.status !== 'fulfilled') throw result.reason; const { row, bytes } = result.value;
            assert(!seen.has(row.path) && !owners.has(row.filename), 'Duplicate semantic checker source path/owner'); seen.add(row.path); owners.add(row.filename);
            checked(bytes, row); total += bytes.length; assert(total <= 512 * 1024 * 1024); sources.push(structuredClone(row));
            const text = bytes.toString(), view = lexicalReferenceView(text);
            if (row.path !== HOST) {
                assert(!/\bKtSourceElement\s*\(/.test(view), 'New selected sealed source-family constructor');
                assert(!/\b(?:import|typealias)\b[^\n]*\bKtSourceElement\b[^\n]*(?:\bas\b|=)|\btypealias\b[^\n]*=\s*(?:[\w.]+\.)?KtSourceElement\b/.test(view), 'Source-family alias requires review');
            }
            assert(!/\b(?:class|object|interface)\s+Kt\w*PsiSourceElement\b/.test(view), 'Selected PSI implementation');
            if (TARGETS.includes(row.path)) {
                const expected = phase === 'before' ? original.get(row.path) : applyCheckerChanges(original.get(row.path), input.lock.changes[row.path]);
                assert.deepEqual(canonical(bytes, input), expected, 'Selected complete semantic checker algorithm/import changed: ' + row.path);
            }
            const boundary = input.lock.boundaries.find(r => r.path === row.path);
            if (boundary) { checked(canonical(bytes, input), boundary, 'Semantic checker required boundary changed: ' + row.path); boundaries.push(structuredClone(row)); }
            const names = checkerReferences(text);
            if (names.length) {
                assert([...TARGETS, ...REGISTRIES].includes(row.path), 'New semantic checker declaration consumer or shadow: ' + row.path);
                references.push({ path: row.path, names });
            }
            required.delete(row.path);
        }
    }
    assert.equal(required.size, 0, 'Missing complete semantic checker or required boundary: ' + [...required].join(','));
    assert.deepEqual(references, input.lock.primaryReferences, 'Actual semantic checker registration/consumer closure changed');
    return { sources, references, boundaries, inspectedBytes: total };
}
async function hostBinding(preparedHost, selected, input) {
    assert(preparedHost?.receiptPath && preparedHost.receipt); const receiptPath = path.resolve(preparedHost.receiptPath); outputPath(receiptPath);
    const bytes = await readRegular(receiptPath), receipt = JSON.parse(bytes); assert.deepEqual(receipt, preparedHost.receipt);
    assert.equal(receipt.kind, 'official-compiler-portable-source-host-preparation'); assert.equal(receipt.sourceLockSha256, input.lock.sourceHostLockSha256);
    for (const logical of [HOST, PARSER]) {
        const pin = receipt.sources.find(r => r.path === logical), boundary = input.lock.boundaries.find(r => r.path === logical); assert(pin && boundary);
        assert.deepEqual({ bytes: pin.bytes, sha256: pin.sha256 }, { bytes: boundary.bytes, sha256: boundary.sha256 });
        assert(preparedHost.commonSources.includes(selected.sources.find(r => r.path === logical).filename), 'Wrong prepared source host owner');
    }
    const host = canonical(await readRegular(selected.sources.find(r => r.path === HOST).filename), input).toString();
    assert(host.includes('sealed class KtSourceElement : AbstractKtSourceElement()'));
    assert.equal([...host.matchAll(/: KtSourceElement\(/g)].length, 1); assert(host.includes('class KtLightSourceElement('));
    assert(!/\bclass Kt\w*PsiSourceElement\b/.test(host));
    assert(canonical(await readRegular(selected.sources.find(r => r.path === ENTRY).filename), input).toString().includes('MultiplatformParsing2Fir(session, provider.kotlinScopeProvider, diagnosticReporter)'));
    return { receiptPath, receiptSha256: sha256(bytes), sourceLockSha256: receipt.sourceLockSha256, sourceOwners: [HOST, PARSER].map(p => selected.sources.find(r => r.path === p)) };
}
function receiptFor(input, sourceRoot, audit, selection, host, files) {
    return { schemaVersion: 1, kind: 'official-fir-lighttree-semantic-checker-preparation', source: input.lock.source,
        sourceRoot, sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: input.lock.dependencies.find(r => r.path === 'prepare.mjs').sha256,
        audit, selection, host, files, replacedOriginalPaths: TARGETS, sourceSetExclusions: [],
        fullFirRuntime: false, fullCompilerBuilt: false, tokenMappingImplemented: false };
}
export async function prepareFirLightTreeSemanticCheckers({ sourceRoot, outputRoot, retainedSources, preparedHost, recordedPropertyImports }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); outputPath(outputRoot);
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep));
    const input = await inputs(); assert.deepEqual(recordedPropertyImports, input.lock.recordedPropertyImports, 'Semantic checker unrecorded property imports');
    const original = await originals(sourceRoot, input), audit = await primaryAudit(sourceRoot, input), selected = await selection(retainedSources, input, original, 'before');
    const host = await hostBinding(preparedHost, selected, input), files = [], commonSources = [];
    async function put(logical, bytes) { const filename = path.join(outputRoot, logical); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename; }
    for (const [logical, bytes] of original) await put('original/' + logical, bytes);
    for (const logical of TARGETS) {
        const before = selected.sources.find(r => r.path === logical), bytes = await readRegular(before.filename); await put('predecessor/' + logical, bytes);
        const transformed = applyCheckerChanges(bytes, input.lock.changes[logical]);
        assert.deepEqual(applyCheckerChanges(transformed, input.lock.changes[logical], true), bytes);
        const filename = await put(logical, transformed), after = { ...before, filename, ...identity(transformed) };
        files.push({ before, after }); commonSources.push(filename);
    }
    const receipt = receiptFor(input, sourceRoot, audit, selected, host, files);
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath)), commonSources, replacedOriginalPaths: TARGETS, sourceSetExclusions: [] };
}
export async function verifyFirLightTreeSemanticCheckerFinalSources({ outputRoot, retainedSources, expectedReceiptSha256 }) {
    outputRoot = path.resolve(outputRoot); outputPath(outputRoot); await assertNoSymlink(outputRoot); const input = await inputs();
    assert.match(expectedReceiptSha256 ?? '', /^[0-9a-f]{64}$/); const bytes = await readRegular(path.join(outputRoot, 'receipt.json'), 64 * 1024 * 1024);
    assert.equal(sha256(bytes), expectedReceiptSha256, 'Semantic checker preparation receipt digest changed'); const receipt = JSON.parse(bytes);
    assert.equal(receipt.schemaVersion, 1, 'Semantic checker preparation schema changed');
    assert.equal(receipt.kind, 'official-fir-lighttree-semantic-checker-preparation'); assert.deepEqual(receipt.source, input.lock.source);
    assert.equal(receipt.sourceLockSha256, sha256(input.lockBytes)); assert.equal(receipt.preparationToolSha256, sha256(await readRegular(fileURLToPath(import.meta.url))));
    assert.deepEqual(receipt.replacedOriginalPaths, TARGETS); assert.deepEqual(receipt.sourceSetExclusions, []);
    assert.equal(receipt.fullFirRuntime, false); assert.equal(receipt.fullCompilerBuilt, false); assert.equal(receipt.tokenMappingImplemented, false);
    const original = await originals(path.join(outputRoot, 'original'), input), selected = await selection(retainedSources, input, original, 'after');
    assert(path.isAbsolute(receipt.sourceRoot)); await assertNoSymlink(receipt.sourceRoot);
    assert.deepEqual(await originals(receipt.sourceRoot, input), original, 'Semantic checker archived original source cache changed');
    const prior = await selection(receipt.selection.sources, input, original, 'before');
    const primaryPins = input.primary.files.filter(r => ['kotlin', 'java'].includes(r.language));
    const audit = { inspectedFiles: primaryPins.length, inventorySha256: sha256(Buffer.from(JSON.stringify(primaryPins))), references: input.lock.primaryReferences };
    assert.deepEqual(receipt.audit, audit, 'Semantic checker primary audit receipt changed');
    assert.deepEqual(selected.boundaries, receipt.selection.boundaries, 'Semantic checker required boundary owner/metadata changed');
    assert.equal(sha256(await readRegular(receipt.host.receiptPath)), receipt.host.receiptSha256, 'Semantic checker original host receipt changed');
    assert.equal(receipt.host.sourceLockSha256, input.lock.sourceHostLockSha256);
    assert.deepEqual(receipt.host.sourceOwners, [HOST, PARSER].map(p => selected.sources.find(r => r.path === p)));
    const hostReceipt = JSON.parse(await readRegular(receipt.host.receiptPath));
    const host = await hostBinding({ receiptPath: receipt.host.receiptPath, receipt: hostReceipt, commonSources: receipt.host.sourceOwners.map(r => r.filename) }, prior, input);
    assert.deepEqual(receipt.files.map(r => r.before.path), TARGETS); const reverse = new Map(), files = [];
    for (const { before, after } of receipt.files) {
        assert.equal(after.path, before.path); assert.equal(after.filename, path.join(outputRoot, after.path), 'Semantic checker canonical owner changed');
        assert.deepEqual(selected.sources.find(r => r.path === after.path), after, 'Final semantic checker source owner/metadata changed');
        assert.deepEqual(receipt.selection.sources.find(r => r.path === before.path), before, 'Semantic checker predecessor metadata changed');
        const predecessor = checked(await readRegular(path.join(outputRoot, 'predecessor', before.path)), before);
        assert.deepEqual(canonical(predecessor, input), original.get(before.path), 'Semantic checker complete predecessor algorithm changed');
        assert.deepEqual(applyCheckerChanges(await readRegular(after.filename), input.lock.changes[before.path], true), predecessor, 'Semantic checker full reverse reconstruction differs');
        checked(await readRegular(before.filename), before, 'Semantic checker original selected owner changed'); reverse.set(before.path, structuredClone(before));
        const expectedAfter = { ...before, filename: path.join(outputRoot, before.path), ...identity(applyCheckerChanges(predecessor, input.lock.changes[before.path])) };
        assert.deepEqual(after, expectedAfter, 'Semantic checker replacement must preserve complete predecessor metadata'); files.push({ before, after: expectedAfter });
    }
    assert.deepEqual(receipt, receiptFor(input, receipt.sourceRoot, audit, prior, host, files), 'Semantic checker canonical preparation receipt changed');
    const predecessorRetainedSources = selected.sources.map(r => reverse.get(r.path) ?? structuredClone(r));
    const changed = predecessorRetainedSources.map((r, n) => JSON.stringify(r) === JSON.stringify(selected.sources[n]) ? null : r.path).filter(Boolean);
    assert.deepEqual(changed.sort(), TARGETS.slice().sort(), 'Semantic checker reverse must replace exactly two complete rows');
    return { receipt: { schemaVersion: 1, kind: 'official-fir-lighttree-semantic-checker-final-selection', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), preparationReceiptSha256: expectedReceiptSha256, actualSelectedSources: selected.sources.length,
        files: receipt.files, boundaries: selected.boundaries, references: selected.references, sourceSetExclusions: [],
        exactTwoRowReverseVerified: true, completeMetadataAndOrderPreserved: true, registrationsPreserved: true,
        preservedLightTreeCheckAndDiagnosticAlgorithms: true, fullFirRuntime: false, fullCompilerBuilt: false, tokenMappingImplemented: false }, predecessorRetainedSources };
}
