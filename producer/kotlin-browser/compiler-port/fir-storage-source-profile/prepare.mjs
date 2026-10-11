import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { assertNoSymlink, json, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { CONFIG, ELEMENT, HOST, STORAGE, UTILS, profileStorage } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..'), limit = 256 * 1024 * 1024;
const algorithm = text => text.replace(/^import [^\r\n]+\r?\n/gm, '').replace(/^(package[^\r\n]+\r?\n)\s*\n/m, '$1');
const pin = (logical, bytes) => ({ path: logical, bytes: bytes.length, sha256: sha256(bytes) });
function verifyGenerated(bytes, pin) { assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); return bytes; }

export async function verifyFirStorageEntryBindings(entryRoot = path.resolve(here, '../entry')) {
    const lock = JSON.parse(await readRegular(path.join(here, 'sources.lock.json')));
    assert.deepEqual(lock.entries.map(entry => entry.path), ['compiler-port-entry/BrowserCompiler.kt', 'compiler-port-entry/BrowserCompilerPipeline.kt']);
    const entries = new Map();
    for (const entry of lock.entries) {
        const name = path.basename(entry.path);
        assert.equal(entry.repositoryPath, '../entry/' + name);
        const bytes = await readRegular(path.join(entryRoot, name));
        const message = 'FIR storage entry binding changed: ' + entry.path + '; update fir-storage-source-profile/sources.lock.json';
        assert.equal(bytes.length, entry.bytes, message + ' (bytes)');
        assert.equal(sha256(bytes), entry.sha256, message + ' (sha256)');
        entries.set(entry.path, bytes);
    }
    return entries;
}

async function verifyPrimary(lock) {
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'official-fir-storage-lighttree-source-profile');
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    assert.deepEqual(lock.sources.map(item => item.path), [STORAGE, CONFIG, UTILS, HOST, ELEMENT]);
    assert.deepEqual(lock.entries.map(item => item.path), ['compiler-port-entry/BrowserCompiler.kt', 'compiler-port-entry/BrowserCompilerPipeline.kt']);
    const bytes = await readRegular(path.join(here, '../closure.lock.json')), primary = JSON.parse(bytes);
    assert.equal(sha256(bytes), lock.primaryClosureSha256); assert.deepEqual(lock.source, primary.source);
    for (const pin of [...lock.sources, ...lock.references]) { const matches = primary.files.filter(item => item.path === pin.path);
        assert.equal(matches.length, 1); assert.deepEqual(pin, matches[0]); }
}

async function inputs(sourceRoot, preparedFirStorage, preparedHost) {
    await assertNoSymlink(sourceRoot);
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'official-fir-storage-lighttree-source-profile');
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    await verifyPrimary(lock);
    assert.equal(sha256(await readRegular(path.join(here, 'transform.mjs'))), lock.transformSha256);
    const originals = new Map();
    for (const item of [...lock.sources, ...lock.references]) originals.set(item.path, verifyFile(await readRegular(path.join(sourceRoot, item.path)), item));
    assert(originals.get(UTILS).includes(Buffer.from(lock.psiGetter.text)));
    assert.equal(Buffer.byteLength(lock.psiGetter.text), lock.psiGetter.bytes); assert.equal(sha256(Buffer.from(lock.psiGetter.text)), lock.psiGetter.sha256);
    assert(originals.get(ELEMENT).includes(Buffer.from('val source: KtSourceElement?')));
    for (const [logical, bytes] of await verifyFirStorageEntryBindings()) originals.set(logical, bytes);
    const predecessors = {}, bindings = [];
    for (const [name, prepared, logical, directory, kind, listKey] of [
        ['storage', preparedFirStorage, STORAGE, 'fir-storage', 'official-fir-ir-serial-cache-lock-source-preparation', 'files'],
        ['host', preparedHost, HOST, 'host', 'official-compiler-portable-source-host-preparation', 'sources'],
    ]) {
        const contract = lock.predecessors[name];
        for (const [file, hash] of Object.entries(contract.tools)) assert.equal(sha256(await readRegular(path.join(here, '..', directory, file))), hash);
        assert(prepared?.receiptPath && prepared.receipt && prepared.commonSources, 'Genuine ' + name + ' preparation required');
        const receiptBytes = await readRegular(prepared.receiptPath), receipt = JSON.parse(receiptBytes);
        assert.deepEqual(receipt, prepared.receipt); assert.equal(receipt.kind, kind); assert.deepEqual(receipt.source, contract.source);
        assert.equal(receipt.sourceLockSha256, contract.tools['sources.lock.json']);
        if (name === 'storage') assert.equal(receipt.preparationToolSha256, contract.tools['prepare.mjs']);
        const declared = receipt[listKey].filter(item => item.path === logical); assert.equal(declared.length, 1);
        assert.deepEqual(declared[0], { path: logical, bytes: contract.bytes, sha256: contract.sha256,
            originalSha256: lock.sources.find(item => item.path === logical).sha256 });
        const matches = prepared.commonSources.filter(filename => path.resolve(filename).endsWith('/' + logical)); assert.equal(matches.length, 1);
        const filename = path.resolve(matches[0]); assert(filename.startsWith(path.join(repository, 'out') + path.sep));
        const bytes = verifyGenerated(await readRegular(filename), contract);
        const binding = { component: name === 'storage' ? 'firStorageReceipt' : 'sourceHostReceipt', logicalPath: logical, componentRelativePath: logical,
            filename, bytes: bytes.length, sha256: sha256(bytes), receiptSha256: sha256(receiptBytes), sourceLockSha256: receipt.sourceLockSha256,
            preparationToolSha256: contract.tools['prepare.mjs'] };
        predecessors[name] = { bytes, receiptBytes, binding }; bindings.push(binding);
    }
    return { lockBytes, lock, originals, predecessors, bindings };
}

export function guardStorageSelection(snapshot, input, { final = false } = {}) {
    assert(Array.isArray(snapshot) && snapshot.length > 0 && snapshot.length <= 20000);
    const seen = new Set(), selected = [], configurationCalls = [], forbiddenConsumers = [], sourceFamily = []; let total = 0;
    const expectedSources = new Map(input.originals);
    expectedSources.set(STORAGE, final ? profileStorage(input.predecessors.storage.bytes, input.lock).bytes : input.predecessors.storage.bytes);
    expectedSources.set(HOST, input.predecessors.host.bytes);
    const selectedPaths = [STORAGE, CONFIG, UTILS, HOST, ELEMENT, ...input.lock.entries.map(item => item.path)];
    for (const item of snapshot) {
        relativePath(item.path); assert(item.path.endsWith('.kt') && !seen.has(item.path)); seen.add(item.path);
        const bytes = Buffer.from(item.source, 'base64'); assert.equal(bytes.length, item.bytes); assert.equal(sha256(bytes), item.sha256);
        total += bytes.length; assert(total <= limit); const text = bytes.toString();
        if (selectedPaths.includes(item.path)) {
            assert.equal(algorithm(text), algorithm(expectedSources.get(item.path).toString()), 'Selected source algorithm changed: ' + item.path);
            selected.push({ path: item.path, bytes: bytes.length, sha256: sha256(bytes), canonicalSha256: sha256(expectedSources.get(item.path)) });
        }
        if (item.path !== HOST) {
            // Kotlin sealed constructors forbid external runtime implementations. The conservative lexical guard also rejects aliasing.
            assert(!/\bKtSourceElement\s*(?:\/\*[\s\S]*?\*\/\s*)?\(/.test(text), 'New selected source-family constructor: ' + item.path);
            assert(!/^import\s+org\.jetbrains\.kotlin\.KtSourceElement\s+as\b/m.test(text), 'Selected source-family alias');
        }
        assert(!/\b(?:class|object|interface)\s+Kt\w*PsiSourceElement\b/.test(text), 'Selected PSI source implementation');
        if (item.path !== CONFIG) {
            for (const match of text.matchAll(/\bfor(?:KlibCompilation|JvmCompilation|JKlibCompilation|AnalysisApi)\b/g)) {
                assert(item.path === input.lock.entries[0].path && match[0] === 'forKlibCompilation', 'Unapproved FIR2IR configuration factory consumer: ' + item.path);
                configurationCalls.push({ path: item.path, factory: match[0], offset: match.index });
            }
            assert(!/\bFir2IrConfiguration\s*\(/.test(text), 'Unapproved direct configuration construction');
        }
        if (/\b(?:NonCachedSourceFacadeContainerSource|JvmFileClassUtil|FacadeClassSource|JvmClassName)\b/.test(text)) {
            assert(!final && item.path === STORAGE, 'Excluded facade island consumer outside original storage: ' + item.path);
            forbiddenConsumers.push(item.path);
        }
        if (/\bsealed class KtSourceElement\b/.test(text)) { assert.equal(item.path, HOST); sourceFamily.push(item.path); }
    }
    assert.deepEqual(selected.map(item => item.path).sort(), selectedPaths.sort(), 'Exact source, getter, entry and configuration closure required');
    assert.equal(configurationCalls.length, 1); assert.deepEqual(sourceFamily, [HOST]);
    const host = input.predecessors.host.bytes.toString();
    assert(host.includes('sealed class KtSourceElement : AbstractKtSourceElement()'));
    assert(host.includes(') : KtSourceElement()')); assert(!/\b(?:class|object)\s+Kt\w*PsiSourceElement\b/.test(host));
    return { inspectedFiles: snapshot.length, inspectedBytes: total, selected, configurationCalls, sourceFamily,
        facadeIslandConsumers: forbiddenConsumers, purePsiGetterSha256: input.lock.psiGetter.sha256,
        allowNonCachedDeclarations: false, publicKlibFactoryOnly: true, lightTreeSourceHostOnly: true,
        limitation: 'Exact selected body pins and conservative lexical closure; no resolved whole FIR call-graph or full storage runtime claim' };
}

async function snapshotSources(retainedSources) {
    const result = [];
    for (const item of retainedSources) {
        const bytes = await readRegular(item.filename); assert.equal(bytes.length, item.bytes); assert.equal(sha256(bytes), item.sha256);
        result.push({ ...pin(item.path, bytes), source: bytes.toString('base64') });
    }
    return result;
}

function receiptFor(input, transformed, snapshotPin, guard, referencePins) {
    return { schemaVersion: 1, kind: 'official-fir-storage-lighttree-profile-preparation', source: input.lock.source,
        primaryClosureSha256: input.lock.primaryClosureSha256, sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: input.prepareSha256, transformSha256: input.lock.transformSha256,
        originalInputs: input.lock.sources, forwardEntryBindings: input.lock.entries, references: input.lock.references, referencePins,
        predecessorBindings: [input.predecessors.storage.binding], sourceHostBinding: input.predecessors.host.binding,
        output: { path: STORAGE, ...input.lock.output }, snapshot: snapshotPin, guard, exclusions: transformed.exclusions,
        replacedOriginalPaths: [STORAGE], unchangedOutsidePrivatePsiIsland: true, lightTreeProviderCachePackageAlgorithmsPreserved: true,
        fullFirStorageRuntime: false, fullCompilerBuilt: false, publicLanguageSupport: false };
}

export async function prepareFirStorageSourceProfile({ sourceRoot, outputRoot, preparedFirStorage, preparedHost, retainedSources, forwardSources = [] }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    for (const root of [sourceRoot, preparedFirStorage?.outputRoot, preparedHost?.outputRoot].filter(Boolean).map(item => path.resolve(item)))
        assert(root !== outputRoot && !root.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(root + path.sep), 'Input/output overlap');
    const input = await inputs(sourceRoot, preparedFirStorage, preparedHost); input.prepareSha256 = sha256(await readRegular(fileURLToPath(import.meta.url)));
    const transformed = profileStorage(input.predecessors.storage.bytes, input.lock), snapshot = await snapshotSources([...retainedSources, ...forwardSources]);
    const guard = guardStorageSelection(snapshot, input); await assertNoSymlink(outputRoot); await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const referencePins = [];
    async function publish(relative, bytes) { const filename = path.join(outputRoot, relative); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        referencePins.push(pin(relative, bytes)); return filename; }
    for (const [logical, bytes] of input.originals) await publish('reference/' + logical, bytes);
    for (const [name, predecessor] of Object.entries(input.predecessors)) {
        await publish('predecessor/' + name + '.kt', predecessor.bytes); await publish('predecessor/' + name + '.json', predecessor.receiptBytes);
        await publish('predecessor/' + name + '-binding.json', Buffer.from(json(predecessor.binding)));
    }
    const references = referencePins.slice(), packed = gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 6 });
    const snapshotPin = pin('selected-source-snapshot.json.gz', packed); await publish(snapshotPin.path, packed);
    const filename = await publish(STORAGE, transformed.bytes), receipt = receiptFor(input, transformed, snapshotPin, guard, references);
    const receiptPath = path.join(outputRoot, 'fir-storage-source-profile-inputs.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, commonSources: [filename], replacedOriginalPaths: [STORAGE], predecessorBindings: receipt.predecessorBindings, receipt, receiptPath };
}

async function replayPreparation(root) {
    root = path.resolve(root); assert(root.startsWith(path.join(repository, 'out') + path.sep)); await assertNoSymlink(root);
    const receiptBytes = await readRegular(path.join(root, 'fir-storage-source-profile-inputs.json')), receipt = JSON.parse(receiptBytes);
    const contract = JSON.parse(await readRegular(path.join(here, 'sources.lock.json'))); await verifyPrimary(contract);
    // Replay uses original binding paths only after verifying immutable saved bytes against the current locked predecessor contracts.
    const originals = new Map();
    for (const item of [...contract.sources, ...contract.references]) originals.set(item.path, verifyFile(await readRegular(path.join(root, 'reference', item.path)), item));
    assert(originals.get(UTILS).includes(Buffer.from(contract.psiGetter.text)));
    assert.equal(Buffer.byteLength(contract.psiGetter.text), contract.psiGetter.bytes); assert.equal(sha256(Buffer.from(contract.psiGetter.text)), contract.psiGetter.sha256);
    assert(originals.get(ELEMENT).includes(Buffer.from('val source: KtSourceElement?')));
    for (const entry of contract.entries) originals.set(entry.path, verifyGenerated(await readRegular(path.join(root, 'reference', entry.path)), entry));
    const predecessors = {}, bindings = [], referencePins = [...originals].map(([logical, bytes]) => pin('reference/' + logical, bytes));
    for (const [name, logical, directory, kind, listKey] of [['storage', STORAGE, 'fir-storage', 'official-fir-ir-serial-cache-lock-source-preparation', 'files'],
        ['host', HOST, 'host', 'official-compiler-portable-source-host-preparation', 'sources']]) {
        for (const [file, hash] of Object.entries(contract.predecessors[name].tools)) assert.equal(sha256(await readRegular(path.join(here, '..', directory, file))), hash);
        const bytes = verifyGenerated(await readRegular(path.join(root, 'predecessor', name + '.kt')), contract.predecessors[name]);
        const receiptBytes = await readRegular(path.join(root, 'predecessor', name + '.json')), predecessorReceipt = JSON.parse(receiptBytes);
        assert.equal(predecessorReceipt.kind, kind); assert.deepEqual(predecessorReceipt.source, contract.predecessors[name].source);
        assert.equal(predecessorReceipt.sourceLockSha256, contract.predecessors[name].tools['sources.lock.json']);
        if (name === 'storage') assert.equal(predecessorReceipt.preparationToolSha256, contract.predecessors[name].tools['prepare.mjs']);
        const declared = predecessorReceipt[listKey].filter(item => item.path === logical); assert.equal(declared.length, 1);
        assert.deepEqual(declared[0], { path: logical, bytes: bytes.length, sha256: sha256(bytes), originalSha256: contract.sources.find(item => item.path === logical).sha256 });
        const bindingBytes = await readRegular(path.join(root, 'predecessor', name + '-binding.json')), binding = JSON.parse(bindingBytes);
        assert(path.isAbsolute(binding.filename) && binding.filename.startsWith(path.join(repository, 'out') + path.sep) && binding.filename.endsWith('/' + logical));
        assert.deepEqual(binding, { component: name === 'storage' ? 'firStorageReceipt' : 'sourceHostReceipt', logicalPath: logical, componentRelativePath: logical,
            filename: binding.filename, bytes: bytes.length, sha256: sha256(bytes), receiptSha256: sha256(receiptBytes), sourceLockSha256: predecessorReceipt.sourceLockSha256,
            preparationToolSha256: contract.predecessors[name].tools['prepare.mjs'] });
        assert.deepEqual(bindingBytes, Buffer.from(json(binding))); predecessors[name] = { bytes, receiptBytes, binding }; bindings.push(binding);
        referencePins.push(pin('predecessor/' + name + '.kt', bytes), pin('predecessor/' + name + '.json', receiptBytes), pin('predecessor/' + name + '-binding.json', bindingBytes));
    }
    assert.equal(contract.transformSha256, sha256(await readRegular(path.join(here, 'transform.mjs'))));
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json'));
    const input = { lockBytes, lock: contract, originals, predecessors, bindings, prepareSha256: sha256(await readRegular(fileURLToPath(import.meta.url))) };
    assert.equal(receipt.snapshot.path, 'selected-source-snapshot.json.gz'); const packed = verifyGenerated(await readRegular(path.join(root, receipt.snapshot.path), limit), receipt.snapshot);
    const snapshot = JSON.parse(gunzipSync(packed, { maxOutputLength: limit })), transformed = profileStorage(predecessors.storage.bytes, contract);
    const guard = guardStorageSelection(snapshot, input); assert.deepEqual(receipt, receiptFor(input, transformed, receipt.snapshot, guard, referencePins));
    return { input, transformed, receipt, receiptSha256: sha256(receiptBytes) };
}

export async function verifyFirStorageSourceProfile(root) {
    const replayed = await replayPreparation(root); assert.deepEqual(await readRegular(path.join(root, STORAGE)), replayed.transformed.bytes);
    return { receipt: replayed.receipt, receiptSha256: replayed.receiptSha256 };
}

export async function verifyFinalFirStorageSourceProfile({ profileRoot, retainedSources, allowedAddedImports = [] }) {
    const replayed = await replayPreparation(profileRoot), snapshot = await snapshotSources(retainedSources), guard = guardStorageSelection(snapshot, replayed.input, { final: true });
    const canonical = new Map(replayed.input.originals); canonical.set(STORAGE, replayed.transformed.bytes); canonical.set(HOST, replayed.input.predecessors.host.bytes);
    for (const logical of [STORAGE, CONFIG, UTILS, HOST, ELEMENT, ...replayed.input.lock.entries.map(item => item.path)]) {
        const expected = [...canonical.get(logical).toString().matchAll(/^import ([^\r\n]+)\r?\n/gm)].map(match => match[1]);
        const actual = snapshot.find(item => item.path === logical), observed = [...Buffer.from(actual.source, 'base64').toString().matchAll(/^import ([^\r\n]+)\r?\n/gm)].map(match => match[1]);
        assert.equal(new Set(observed).size, observed.length); for (const item of expected) assert(observed.includes(item), 'Canonical import removed');
        for (const item of observed) assert(expected.includes(item) || allowedAddedImports.includes(item), 'Unknown final import added: ' + item);
    }
    const matches = retainedSources.filter(item => item.path === STORAGE); assert.equal(matches.length, 1);
    assert.equal(path.resolve(matches[0].filename), path.join(path.resolve(profileRoot), STORAGE));
    return { schemaVersion: 1, kind: 'official-fir-storage-lighttree-final-selection-guard', preparationReceiptSha256: replayed.receiptSha256, guard,
        fullFirStorageRuntime: false, fullCompilerBuilt: false, publicLanguageSupport: false };
}
