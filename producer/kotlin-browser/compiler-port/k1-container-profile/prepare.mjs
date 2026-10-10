import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { selectedDeclarations } from '../backend-profile/references.mjs';
import { PATHS, CANDIDATES, PROPERTY, COMMENT_LINES, splitK1Declaration, verifyHostVariant } from './transform.mjs';
import { guardK1References } from './guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const LIMIT = 128 * 1024 * 1024;
const RETAINED_CONTRACTS = ['compiler/frontend.common/src/org/jetbrains/kotlin/analyzer/ModuleInfo.kt',
    'core/compiler.common/src/org/jetbrains/kotlin/resolve/DefaultImportsProvider.kt'];
const inventory = sources => sources.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
const inventoryHash = sources => sha256(Buffer.from(JSON.stringify(inventory(sources))));

async function loadLock() {
    const bytes = await readRegular(path.join(HERE, 'sources.lock.json')); const lock = JSON.parse(bytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'official-k1-reflection-container-source-profile');
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    assert.deepEqual(lock.candidatePaths, CANDIDATES); assert.deepEqual(lock.replacedOriginalPaths, PATHS);
    assert.equal(lock.removedAnalyzerProperty, PROPERTY); assert.deepEqual(lock.removedPureKDoc, COMMENT_LINES);
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json'));
    assert.equal(sha256(closureBytes), lock.primaryClosureSha256); const closure = JSON.parse(closureBytes);
    assert.deepEqual(lock.source, closure.source);
    assert.deepEqual(lock.originals.map(item => item.path), [...CANDIDATES, ...PATHS]);
    for (const pin of lock.originals) assert.deepEqual(pin.original, closure.files.find(item => item.path === pin.path));
    assert.deepEqual(lock.retainedContracts.map(pin => pin.path), RETAINED_CONTRACTS);
    for (const pin of lock.retainedContracts) assert.deepEqual(pin, closure.files.find(item => item.path === pin.path));
    assert.deepEqual(lock.probeSources, [closure.files.find(item => item.path === 'core/util.runtime/src/org/jetbrains/kotlin/K1Deprecation.kt')]);
    for (const [filename, expected] of Object.entries(lock.tools)) assert.equal(sha256(await readRegular(path.join(HERE, filename))), expected, 'Profile tool changed: ' + filename);
    // Derive the exact genuine Java-property API from the independently pinned AST port.
    const dependency = lock.hostPropertyImports;
    const astLockBytes = await readRegular(path.join(HERE, dependency.sourceLockPath)); assert.equal(sha256(astLockBytes), dependency.sourceLockSha256);
    const astLock = JSON.parse(astLockBytes); assert.deepEqual(astLock.source, lock.source);
    assert.deepEqual(dependency.bridge, astLock.portable.find(pin => pin.path.endsWith('/JavaProperties.kt')));
    const bridge = verifyFile(await readRegular(path.join(HERE, '../js-ast', dependency.bridge.path)), dependency.bridge);
    const names = new Set([...bridge.toString().matchAll(/^(?:var|val)\s+\w+\.(\w+):/gm)].map(match => match[1]));
    for (const name of ['currentNode', 'replaceMe', 'addPrevious']) names.add(name);
    assert.equal(names.size, 69);
    const astImports = [...names].sort().map(name => 'org.jetbrains.kotlin.js.backend.ast.' + name)
        .concat('org.jetbrains.kotlin.js.util.position', 'org.jetbrains.kotlin.js.util.line', 'org.jetbrains.kotlin.js.util.column');
    assert.deepEqual(dependency.astPropertyImports, astImports);
    assert.deepEqual(dependency.approvedImports, ['org.jetbrains.kotlin.portable.common.*', 'org.jetbrains.kotlin.portable.descriptors.*', ...astImports]);
    return { lock, bytes, closure, primaryPins: closure.files.filter(item => item.compile && item.path.endsWith('.kt')) };
}

function decode(snapshot) {
    assert(Array.isArray(snapshot) && snapshot.length > 0 && snapshot.length <= 20000);
    let size = 0; const names = new Set();
    return snapshot.map(pin => {
        relativePath(pin.path); assert(pin.path.endsWith('.kt')); assert(!names.has(pin.path), 'Duplicate selected logical source: ' + pin.path); names.add(pin.path);
        const source = Buffer.from(pin.source, 'base64'); assert.equal(source.length, pin.bytes); assert.equal(sha256(source), pin.sha256);
        size += source.length; assert(size <= LIMIT, 'Source snapshot exceeds bound');
        return { ...pin, source };
    });
}

function originalsFrom(snapshot, lock) {
    const decoded = new Map(decode(snapshot).map(pin => [pin.path, pin.source]));
    const originals = new Map();
    for (const pin of lock.originals) {
        const bytes = decoded.get(pin.path); assert(bytes, 'Missing pinned K1 original: ' + pin.path);
        originals.set(pin.path, verifyFile(bytes, pin.original));
        if (CANDIDATES.includes(pin.path)) assert.deepEqual(selectedDeclarations(bytes.toString()), lock.declarations[pin.path]);
        else {
            const result = splitK1Declaration(pin.path, bytes);
            assert.equal(result.common.length, pin.preparedBytes); assert.equal(sha256(result.common), pin.preparedSha256);
            assert.deepEqual(result.removed.map(({ kind, text }) => ({ kind, bytes: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)) })), pin.removedSpans);
        }
    }
    return originals;
}

function primaryGuard(snapshot, input, originals) {
    const sources = decode(snapshot); assert.equal(sources.length, input.primaryPins.length);
    assert.deepEqual(sources.map(pin => pin.path), input.primaryPins.map(pin => pin.path));
    for (let i = 0; i < sources.length; i++) verifyFile(sources[i].source, input.primaryPins[i]);
    const splitSources = new Map(PATHS.map(name => [name, splitK1Declaration(name, originals.get(name)).common]));
    return guardK1References({ originals, splitSources, retainedSources: sources, declarations: input.lock.declarations });
}

function composedGuard(snapshot, input, originals, final) {
    const sources = decode(snapshot); const selected = new Map(sources.map(pin => [pin.path, pin.source]));
    assert(selected.has('compiler-port-entry/BrowserCompilerPipeline.kt'), 'Actual browser compiler entry missing from all-input guard');
    const splitSources = new Map(); const hostImports = [];
    for (const pin of input.lock.retainedContracts) {
        const source = selected.get(pin.path); assert(source, 'Required non-K1 contract removed: ' + pin.path);
        // Their complete original bodies are retained, including dependencyOnBuiltIns delegation.
        const primaryOriginal = input.primaryOriginals?.get(pin.path);
        if (primaryOriginal) hostImports.push({ path: pin.path, imports: verifyHostVariant(source, primaryOriginal, input.lock.hostPropertyImports.approvedImports) });
    }
    for (const name of PATHS) {
        const source = selected.get(name); assert(source, 'Missing retained K1 contract: ' + name);
        const canonical = final ? splitK1Declaration(name, originals.get(name)).common : originals.get(name);
        hostImports.push({ path: name, imports: verifyHostVariant(source, canonical, input.lock.hostPropertyImports.approvedImports) });
        splitSources.set(name, final ? source : splitK1Declaration(name, source).common);
    }
    for (const name of CANDIDATES) {
        if (final) assert(!selected.has(name), 'Excluded K1 container input reintroduced: ' + name);
        else {
            assert(selected.has(name), 'Original K1 exclusion candidate not selected: ' + name);
            hostImports.push({ path: name, imports: verifyHostVariant(selected.get(name), originals.get(name), input.lock.hostPropertyImports.approvedImports) });
        }
    }
    const guard = guardK1References({ originals, splitSources, retainedSources: sources, declarations: input.lock.declarations });
    return { guard, hostImports, splitSources };
}

async function readActual(retainedSources) {
    assert(Array.isArray(retainedSources) && retainedSources.length > 0 && retainedSources.length <= 20000);
    const snapshot = []; let size = 0;
    for (let i = 0; i < retainedSources.length; i += 24) {
        const batch = await Promise.all(retainedSources.slice(i, i + 24).map(async pin => {
            const bytes = await readRegular(pin.filename); assert.equal(bytes.length, pin.bytes, 'Actual selected input length changed');
            assert.equal(sha256(bytes), pin.sha256, 'Actual selected input bytes changed');
            return { path: pin.path, bytes: bytes.length, sha256: sha256(bytes), source: bytes.toString('base64') };
        }));
        for (const pin of batch) { size += pin.bytes; assert(size <= LIMIT); snapshot.push(pin); }
    }
    decode(snapshot); return snapshot;
}

async function saveSnapshot(root, name, snapshot) {
    const bytes = gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 9 });
    await writeFile(path.join(root, name), bytes, { flag: 'wx', mode: 0o600 });
    return { path: name, bytes: bytes.length, sha256: sha256(bytes) };
}

async function loadSnapshot(root, pin) {
    relativePath(pin.path); const bytes = await readRegular(path.join(root, pin.path), LIMIT);
    assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
    return JSON.parse(gunzipSync(bytes, { maxOutputLength: LIMIT * 2 }));
}

function makeReceipt(input, originals, primary, composed, snapshots, preparationToolSha256) {
    input.primaryOriginals = new Map(decode(primary).filter(pin => RETAINED_CONTRACTS.includes(pin.path)).map(pin => [pin.path, pin.source]));
    const primaryResult = primaryGuard(primary, input, originals), composedResult = composedGuard(composed, input, originals, false);
    const files = PATHS.map(name => {
        const bytes = composedResult.splitSources.get(name);
        return { path: name, bytes: bytes.length, sha256: sha256(bytes), originalSha256: sha256(originals.get(name)) };
    });
    return { schemaVersion: 1, kind: 'official-k1-reflection-container-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.bytes), preparationToolSha256, tools: input.lock.tools, hostPropertyImports: input.lock.hostPropertyImports,
        sourceSetExclusions: CANDIDATES, replacedOriginalPaths: PATHS, originalReferences: input.lock.originals.map(pin => pin.original),
        primaryInventory: { count: primary.length, sha256: inventoryHash(primary), snapshot: snapshots.primary },
        composedInventory: { count: composed.length, sha256: inventoryHash(composed), snapshot: snapshots.composed },
        explicitEntryBindings: inventory(composed.filter(pin => pin.path.startsWith('compiler-port-entry/'))),
        primaryGuard: primaryResult, composedGuard: composedResult.guard, recordedHostImports: composedResult.hostImports, files,
        retainedContracts: input.lock.retainedContracts, exactRemovedSpans: input.lock.originals.filter(pin => PATHS.includes(pin.path)).map(pin => ({ path: pin.path, spans: pin.removedSpans })),
        originalSourceUnmodified: true, algorithmReplacements: false, diStub: false, languageReadiness: false,
        limitation: 'Conservative lexical declaration/member guard over complete caller-supplied actual inputs; not a resolved semantic call graph or proof of dynamically constructed reflective names' };
}

/** Call after selecting all components; pass every actual Kotlin input, including entry. */
export async function prepareK1ContainerProfile({ sourceRoot, outputRoot, retainedSources }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep));
    await assertNoSymlink(outputRoot); const input = await loadLock();
    const primary = await readActual(input.primaryPins.map(pin => ({ ...pin, filename: path.join(sourceRoot, pin.path) })));
    const originals = originalsFrom(primary, input.lock); const composed = await readActual(retainedSources);
    input.primaryOriginals = new Map(decode(primary).filter(pin => RETAINED_CONTRACTS.includes(pin.path)).map(pin => [pin.path, pin.source]));
    primaryGuard(primary, input, originals); composedGuard(composed, input, originals, false);
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    for (const [name, bytes] of originals) {
        const filename = path.join(outputRoot, 'reference-original', name); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    }
    const snapshots = { primary: await saveSnapshot(outputRoot, 'primary-source-snapshot.json.gz', primary),
        composed: await saveSnapshot(outputRoot, 'composed-source-snapshot.json.gz', composed) };
    const toolHash = sha256(await readRegular(fileURLToPath(import.meta.url)));
    const receipt = makeReceipt(input, originals, primary, composed, snapshots, toolHash);
    const commonSources = [], prepared = composedGuard(composed, input, originals, false);
    for (const name of PATHS) {
        const filename = path.join(outputRoot, name); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, prepared.splitSources.get(name), { flag: 'wx', mode: 0o600 }); commonSources.push(filename);
    }
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { commonSources, replacedOriginalPaths: PATHS, sourceSetExclusions: CANDIDATES, receipt, receiptPath };
}

/** Replay both immutable complete snapshots and compare every original/prepared byte. */
export async function verifyK1ContainerProfile(profileRoot) {
    profileRoot = path.resolve(profileRoot); const input = await loadLock();
    const receiptBytes = await readRegular(path.join(profileRoot, 'receipt.json')); const receipt = JSON.parse(receiptBytes);
    const primary = await loadSnapshot(profileRoot, receipt.primaryInventory.snapshot), composed = await loadSnapshot(profileRoot, receipt.composedInventory.snapshot);
    const originals = originalsFrom(primary, input.lock);
    for (const [name, bytes] of originals) assert.deepEqual(await readRegular(path.join(profileRoot, 'reference-original', name)), bytes);
    assert.deepEqual(receipt, makeReceipt(input, originals, primary, composed, { primary: receipt.primaryInventory.snapshot,
        composed: receipt.composedInventory.snapshot }, sha256(await readRegular(fileURLToPath(import.meta.url)))));
    for (const pin of receipt.files) {
        const bytes = await readRegular(path.join(profileRoot, pin.path)); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
    }
    return { input, receipt, receiptSha256: sha256(receiptBytes), originals };
}

/** Invoke again on the exact final compiler source list after imports/entry/composition. */
export async function verifyK1ContainerProfileComposition({ profileRoot, retainedSources }) {
    const checked = await verifyK1ContainerProfile(profileRoot); const snapshot = await readActual(retainedSources);
    const result = composedGuard(snapshot, checked.input, checked.originals, true);
    const snapshotPin = await saveSnapshot(profileRoot, 'final-source-snapshot.json.gz', snapshot);
    const receipt = { schemaVersion: 1, kind: 'official-k1-final-composition-guard', source: checked.input.lock.source,
        profileReceiptSha256: checked.receiptSha256, sourceLockSha256: sha256(checked.input.bytes),
        inventory: { count: snapshot.length, sha256: inventoryHash(snapshot), snapshot: snapshotPin }, guard: result.guard,
        retainedHostImports: result.hostImports, languageReadiness: false };
    const receiptPath = path.join(profileRoot, 'final-composition.json'); await writeJson(receiptPath, receipt);
    await verifyK1ContainerProfileFinal(profileRoot);
    return { receipt, receiptPath };
}

/** Recheck the preserved final compiler-input snapshot, without relying on caller objects. */
export async function verifyK1ContainerProfileFinal(profileRoot) {
    const checked = await verifyK1ContainerProfile(profileRoot);
    const receipt = JSON.parse(await readRegular(path.join(profileRoot, 'final-composition.json')));
    const snapshot = await loadSnapshot(profileRoot, receipt.inventory.snapshot);
    const result = composedGuard(snapshot, checked.input, checked.originals, true);
    const expected = { schemaVersion: 1, kind: 'official-k1-final-composition-guard', source: checked.input.lock.source,
        profileReceiptSha256: checked.receiptSha256, sourceLockSha256: sha256(checked.input.bytes),
        inventory: { count: snapshot.length, sha256: inventoryHash(snapshot), snapshot: receipt.inventory.snapshot }, guard: result.guard,
        retainedHostImports: result.hostImports, languageReadiness: false };
    assert.deepEqual(receipt, expected, 'Final K1 composition receipt changed');
    return { receipt, receiptSha256: sha256(await readRegular(path.join(profileRoot, 'final-composition.json'))) };
}
