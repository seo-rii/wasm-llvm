import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareDescriptorContracts } from '../descriptors/prepare.mjs';
import { prepareDescriptorVisitorContracts } from '../descriptor-visitor-contract/prepare.mjs';
import { prepareVisitorVoidProfile } from '../visitor-void-profile/prepare.mjs';
import { GENERATED, applySignatureRecipes, inspectSignatureGraph, algorithm } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), LIMIT = 160 * 1024 * 1024;
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const pin = (logical, bytes) => ({ path: logical, bytes: bytes.length, sha256: sha256(bytes) });
function normalize(value, roots) {
    if (typeof value === 'string') {
        for (const [name, root] of Object.entries(roots)) value = value.replaceAll(root, '<' + name + '>');
        return value;
    }
    if (Array.isArray(value)) return value.map(item => normalize(item, roots));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, roots)]));
    return value;
}
function rebindVerifiedReceiptHashes(value, bindings) {
    if (Array.isArray(value)) return value.map(item => rebindVerifiedReceiptHashes(item, bindings));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        const isBinding = key === 'receiptSha256' || key === 'previousVisitorReceiptSha256';
        return [key, isBinding && bindings.has(item) ? bindings.get(item) : rebindVerifiedReceiptHashes(item, bindings)];
    }));
    return value;
}
async function loadInput(sourceRoot) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'selected-descriptor-platform-signature-contract');
    const primaryBytes = await readRegular(path.join(HERE, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
    assert.equal(sha256(primaryBytes), lock.primaryClosureSha256); assert.deepEqual(lock.source, primary.source);
    assert.equal(sha256(await readRegular(path.join(HERE, 'transform.mjs'))), lock.transformSha256);
    for (const dependency of lock.dependencies) assert.equal(sha256(await readRegular(path.join(HERE, '..', dependency.path))), dependency.sha256);
    assert.equal(lock.inputs.length, 11); assert.equal(lock.outputs.length, 11);
    assert.deepEqual(lock.profile, { generatedContracts: 6, nullableUserDataImplementationsPreserved: 6,
        nullableCopyImplementationsPreserved: 4, checkedNonnullCopyImplementations: 3,
        checkedNonnullUserDataImplementations: 1, readonlyUnusedCollectionHeaders: 6,
        copyBuilderBoundsChanged: false, ownGetterAliasChanged: false, javaImplementationFamilyClosed: false,
        fullCompilerBuilt: false, publicLanguageSupport: false });
    const originals = new Map();
    for (const source of lock.sources) {
        relativePath(source.path); assert(!originals.has(source.path));
        assert.deepEqual(source, primary.files.find(item => item.path === source.path));
        originals.set(source.path, verifyFile(await readRegular(path.join(sourceRoot, source.path)), source));
    }
    return { lock, lockBytes, originals };
}
async function snapshotSources(retainedSources) {
    assert(Array.isArray(retainedSources) && retainedSources.length && retainedSources.length <= 20000);
    const snapshot = [], seen = new Set(); let bytesRead = 0;
    for (const source of retainedSources) {
        relativePath(source.path); assert(source.path.endsWith('.kt') && !seen.has(source.path)); seen.add(source.path);
        assert(path.isAbsolute(source.filename));
        const bytes = await readRegular(source.filename); assert.equal(bytes.length, source.bytes); assert.equal(sha256(bytes), source.sha256);
        bytesRead += bytes.length; assert(bytesRead <= LIMIT);
        snapshot.push({ path: source.path, filename: source.filename, bytes: bytes.length, sha256: sha256(bytes), source: bytes.toString('base64') });
    }
    return snapshot;
}
function snapshotCode(snapshot) {
    return snapshot.map(item => {
        const source = Buffer.from(item.source, 'base64'); assert.equal(source.length, item.bytes); assert.equal(sha256(source), item.sha256);
        return { path: item.path, source };
    });
}
async function publish(root, logical, bytes) {
    relativePath(logical); const filename = path.join(root, logical); await assertNoSymlink(filename);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename;
}

/** Reexecute all three entire genuine predecessor preparers, including the Java AST generator. */
async function replayChain(input, snapshot, supplied) {
    const scratch = await mkdtemp(path.join(REPO, 'out/descriptor-signature-private-'));
    try {
        const sourceRoot = path.join(scratch, 'reference');
        for (const [logical, bytes] of input.originals) await publish(sourceRoot, logical, bytes);
        const snapshotFiles = new Map();
        for (const item of snapshot) snapshotFiles.set(item.path, await publish(path.join(scratch, 'selected'), item.path, Buffer.from(item.source, 'base64')));
        const descriptors = await prepareDescriptorContracts(sourceRoot, path.join(scratch, 'descriptors'));
        const visitorLock = JSON.parse(await readRegular(path.join(HERE, '../descriptor-visitor-contract/sources.lock.json')));
        const originals = new Map(visitorLock.originals.map(source => [source.path, source]));
        const generated = new Map(descriptors.receipt.files.map(source => [GENERATED + source.path, source]));
        const canonical = snapshot.map(source => {
            const original = originals.get(source.path);
            if (original) return { path: source.path, filename: path.join(sourceRoot, source.path), bytes: original.bytes, sha256: original.sha256 };
            const output = generated.get(source.path);
            return output ? { path: source.path, filename: output.absolutePath, bytes: output.bytes, sha256: output.sha256 } :
                { path: source.path, filename: snapshotFiles.get(source.path), bytes: source.bytes, sha256: source.sha256 };
        });
        const visitor = await prepareDescriptorVisitorContracts({ sourceRoot, outputRoot: path.join(scratch, 'visitor'), preparedDescriptors: descriptors, retainedSources: canonical });
        const visitorSources = canonical.map(source => {
            const output = visitor.receipt.files.find(item => item.path === source.path);
            return output ? { path: source.path, filename: path.join(scratch, 'visitor', source.path), bytes: output.bytes, sha256: output.sha256 } : source;
        });
        const voidOptions = { sourceRoot, outputRoot: path.join(scratch, 'void'), preparedDescriptors: descriptors,
            descriptorVisitorComponent: visitor, retainedSources: visitorSources };
        const visitorVoid = await prepareVisitorVoidProfile(voidOptions);
        const components = { descriptors, visitor, void: visitorVoid }, roots = {
            descriptors: descriptors.outputRoot, visitor: path.dirname(visitor.receiptPath), void: path.dirname(visitorVoid.receiptPath) };
        const canonicalBytes = new Map();
        for (const output of descriptors.receipt.files) canonicalBytes.set(GENERATED + output.path, await readRegular(output.absolutePath));
        for (const output of visitor.receipt.files) canonicalBytes.set(output.path, await readRegular(path.join(roots.visitor, output.path)));
        for (const output of visitorVoid.receipt.files) canonicalBytes.set(output.path, await readRegular(path.join(roots.void, output.path)));
        for (const source of input.lock.inputs.filter(item => !item.predecessor)) canonicalBytes.set(source.path, input.originals.get(source.path));
        // The whole preceding receipt is proven equal before its path-dependent raw
        // hash is rebound in the next genuine receipt. No hash field is discarded.
        const receiptHashes = new Map();
        for (const name of Object.keys(components)) {
            assert.deepEqual(normalize(rebindVerifiedReceiptHashes(components[name].receipt, receiptHashes), roots), normalize(supplied.receipts[name], supplied.roots),
                'Full canonical predecessor reconstruction differs: ' + name);
            receiptHashes.set(sha256(json(components[name].receipt)), sha256(json(supplied.receipts[name])));
        }
        return { canonicalBytes };
    } finally { await rm(scratch, { recursive: true, force: true }); }
}
function transform(input, canonicalBytes) {
    const common = new Map();
    for (const source of input.lock.inputs) {
        const bytes = canonicalBytes.get(source.path); assert(bytes);
        assert.equal(bytes.length, source.bytes); assert.equal(sha256(bytes), source.sha256);
        const output = applySignatureRecipes(bytes, input.lock.recipes.filter(item => item.path === source.path));
        const expected = input.lock.outputs.find(item => item.path === source.path); assert(expected);
        assert.equal(output.length, expected.bytes); assert.equal(sha256(output), expected.sha256); common.set(source.path, output);
    }
    return common;
}
function receiptFor(input, snapshotPin, predecessorsPin, bindings, guard, preparedGuard) {
    return { schemaVersion: 1, kind: 'selected-descriptor-platform-signature-preparation', source: input.lock.source,
        primaryClosureSha256: input.lock.primaryClosureSha256, sourceLockSha256: sha256(input.lockBytes),
        preparationToolSha256: input.prepareSha256, transformSha256: input.lock.transformSha256,
        references: input.lock.sources, files: input.lock.outputs, recipes: input.lock.recipes, snapshot: snapshotPin,
        predecessors: predecessorsPin, predecessorBindings: bindings, guard, preparedGuard, profile: input.lock.profile,
        originalNullableBodiesPreserved: true, nonnullChecksPreserveDeclaredParameterOrder: true,
        generatedCopyBuilderBoundsUnchanged: true, ownGetterAliasUnchanged: true,
        javaImplementationFamilyClosed: false, fullCompilerBuilt: false, publicLanguageSupport: false };
}
export async function prepareDescriptorPlatformSignatures(options) {
    const outputRoot = path.resolve(options.outputRoot), sourceRoot = path.resolve(options.sourceRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    const supplied = { roots: { descriptors: options.preparedDescriptors.outputRoot,
        visitor: path.dirname(options.descriptorVisitorComponent.receiptPath), void: path.dirname(options.visitorVoidComponent.receiptPath) },
        receipts: { descriptors: options.preparedDescriptors.receipt, visitor: options.descriptorVisitorComponent.receipt, void: options.visitorVoidComponent.receipt } };
    for (const [name, root] of Object.entries(supplied.roots)) {
        assert.deepEqual(await readRegular(path.join(root, 'receipt.json')), json(supplied.receipts[name]), 'Actual predecessor receipt bytes differ');
    }
    for (const original of [sourceRoot, ...Object.values(supplied.roots)]) {
        assert(path.isAbsolute(original)); assert(outputRoot !== original && !outputRoot.startsWith(original + path.sep) && !original.startsWith(outputRoot + path.sep), 'Predecessor/output overlap');
    }
    const input = await loadInput(sourceRoot); input.prepareSha256 = sha256(await readRegular(fileURLToPath(import.meta.url)));
    const snapshot = await snapshotSources(options.retainedSources), replayed = await replayChain(input, snapshot, supplied);
    const selected = new Map(snapshot.map(item => [item.path, item]));
    // Validate all current predecessor outputs, including preserved outputs, at the exact canonical owner path.
    const currentOwners = new Map();
    for (const file of supplied.receipts.descriptors.files) currentOwners.set(GENERATED + file.path, { root: supplied.roots.descriptors, relative: 'generated/' + file.path });
    for (const file of supplied.receipts.visitor.files) currentOwners.set(file.path, { root: supplied.roots.visitor, relative: file.path });
    for (const file of supplied.receipts.void.files) currentOwners.set(file.path, { root: supplied.roots.void, relative: file.path });
    for (const [logical, owner] of currentOwners) {
        const actual = selected.get(logical); assert(actual, 'Missing genuine predecessor output: ' + logical);
        assert.equal(actual.filename, path.join(owner.root, owner.relative), 'Different canonical predecessor owner');
        assert.deepEqual(Buffer.from(actual.source, 'base64'), replayed.canonicalBytes.get(logical));
    }
    assert.deepEqual([...options.preparedDescriptors.sourceFiles].sort(), supplied.receipts.descriptors.files.map(file => file.absolutePath).sort());
    assert.deepEqual(options.descriptorVisitorComponent.commonSources.map(file => path.relative(supplied.roots.visitor, file)).sort(), supplied.receipts.visitor.files.map(file => file.path).sort());
    assert.deepEqual(options.visitorVoidComponent.commonSources.map(file => path.relative(supplied.roots.void, file)).sort(), supplied.receipts.void.files.map(file => file.path).sort());
    const bindings = [];
    for (const source of input.lock.inputs) {
        const actual = selected.get(source.path); assert(actual); assert.equal(actual.bytes, source.bytes); assert.equal(actual.sha256, source.sha256);
        if (source.predecessor) bindings.push({ component: source.predecessor, componentRelativePath: source.path,
            filename: actual.filename, bytes: actual.bytes, sha256: actual.sha256 });
        else assert.equal(actual.filename, path.join(sourceRoot, source.path), 'Original Kotlin source must remain canonical');
    }
    const common = transform(input, replayed.canonicalBytes), guard = inspectSignatureGraph(snapshotCode(snapshot), input.lock.contracts);
    const preparedGuard = inspectSignatureGraph(snapshotCode(snapshot).map(item => ({ ...item, source: common.get(item.path) ?? item.source })), input.lock.contracts, true);
    await assertNoSymlink(outputRoot); await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    for (const [logical, bytes] of input.originals) await publish(outputRoot, 'reference/' + logical, bytes);
    const snapshotBytes = json(snapshot); assert(snapshotBytes.length <= LIMIT, 'Selected snapshot exceeds verified replay bound');
    const packed = gzipSync(snapshotBytes, { level: 6 }), snapshotPin = pin('selected-source-snapshot.json.gz', packed);
    await publish(outputRoot, snapshotPin.path, packed);
    const predecessorsBytes = json(supplied), predecessorsPin = pin('predecessors.json', predecessorsBytes); await publish(outputRoot, predecessorsPin.path, predecessorsBytes);
    const commonSources = [];
    for (const [logical, bytes] of common) commonSources.push(await publish(outputRoot, logical, bytes));
    const receipt = receiptFor(input, snapshotPin, predecessorsPin, bindings, guard, preparedGuard), receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, commonSources, replacedOriginalPaths: [...common.keys()], predecessorBindings: bindings, receipt, receiptPath };
}
async function replay(root) {
    root = path.resolve(root); await assertNoSymlink(root); assert(root.startsWith(path.join(REPO, 'out') + path.sep));
    const input = await loadInput(path.join(root, 'reference')); input.prepareSha256 = sha256(await readRegular(fileURLToPath(import.meta.url)));
    const receiptBytes = await readRegular(path.join(root, 'receipt.json')), receipt = JSON.parse(receiptBytes);
    assert.equal(receipt.snapshot.path, 'selected-source-snapshot.json.gz'); assert.equal(receipt.predecessors.path, 'predecessors.json');
    const packed = await readRegular(path.join(root, receipt.snapshot.path), LIMIT), predecessorsBytes = await readRegular(path.join(root, receipt.predecessors.path), LIMIT);
    assert.deepEqual(pin(receipt.snapshot.path, packed), receipt.snapshot); assert.deepEqual(pin(receipt.predecessors.path, predecessorsBytes), receipt.predecessors);
    const snapshot = JSON.parse(gunzipSync(packed, { maxOutputLength: LIMIT })), supplied = JSON.parse(predecessorsBytes);
    for (const original of Object.values(supplied.roots)) assert(path.isAbsolute(original) && original.startsWith(path.join(REPO, 'out') + path.sep));
    const replayed = await replayChain(input, snapshot, supplied), common = transform(input, replayed.canonicalBytes);
    const guard = inspectSignatureGraph(snapshotCode(snapshot), input.lock.contracts), preparedGuard = inspectSignatureGraph(snapshotCode(snapshot).map(item => ({ ...item, source: common.get(item.path) ?? item.source })), input.lock.contracts, true);
    const bindings = input.lock.inputs.filter(source => source.predecessor).map(source => {
        const actual = snapshot.find(item => item.path === source.path); assert(actual);
        const name = source.predecessor === 'descriptorReceipt' ? 'descriptors' : source.predecessor === 'descriptorVisitorReceipt' ? 'visitor' : 'void';
        const relative = name === 'descriptors' ? 'generated/' + path.basename(source.path) : source.path;
        assert.equal(actual.filename, path.join(supplied.roots[name], relative)); assert.equal(actual.bytes, source.bytes); assert.equal(actual.sha256, source.sha256);
        return { component: source.predecessor, componentRelativePath: source.path, filename: actual.filename, bytes: source.bytes, sha256: source.sha256 };
    });
    assert.deepEqual(receipt, receiptFor(input, receipt.snapshot, receipt.predecessors, bindings, guard, preparedGuard));
    return { receipt, receiptSha256: sha256(receiptBytes), input, common };
}
export async function verifyDescriptorPlatformSignatures(profileRoot) {
    const result = await replay(profileRoot);
    for (const [logical, bytes] of result.common) assert.deepEqual(await readRegular(path.join(profileRoot, logical)), bytes);
    return { receipt: result.receipt, receiptSha256: result.receiptSha256 };
}
export async function verifyFinalDescriptorPlatformSignatures({ profileRoot, retainedSources, allowedAddedImports = [] }) {
    const result = await replay(profileRoot), snapshot = await snapshotSources(retainedSources);
    const guard = inspectSignatureGraph(snapshotCode(snapshot), result.input.lock.contracts, true);
    const imports = bytes => [...bytes.toString().matchAll(/^import ([^\r\n]+)\r?\n/gm)].map(item => item[1]);
    const checked = [];
    for (const [logical, expected] of result.common) {
        const actual = snapshot.find(item => item.path === logical); assert(actual);
        assert.equal(actual.filename, path.join(path.resolve(profileRoot), logical), 'Final selected replacement filename differs');
        const bytes = Buffer.from(actual.source, 'base64'); assert.equal(algorithm(bytes), algorithm(expected), 'Final descriptor algorithm changed: ' + logical);
        const required = imports(expected), observed = imports(bytes); assert.equal(new Set(observed).size, observed.length, 'Duplicate final import');
        for (const item of required) assert(observed.includes(item), 'Canonical descriptor import removed');
        for (const item of observed) assert(required.includes(item) || allowedAddedImports.includes(item), 'Unknown final import');
        checked.push({ path: logical, filename: actual.filename, bytes: bytes.length, sha256: sha256(bytes) });
    }
    return { schemaVersion: 1, kind: 'selected-descriptor-platform-final-selection', preparationReceiptSha256: result.receiptSha256,
        checked, guard, onlyAllowedAssemblyImports: true, fullCompilerBuilt: false, publicLanguageSupport: false };
}
