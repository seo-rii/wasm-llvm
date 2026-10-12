import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { normalizeRecordedImports } from '../serializer-output-bindings/transform.mjs';
import { DECLARATIONS, TARGETS, SYMBOLS, FACADES, DEFERRED, HOMONYM,
    distributionDeclarations, distributionReferences, distributionDynamicNames } from './references.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const LIMIT = 64 * 1024 * 1024;
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const normalized = (bytes, input) => normalizeRecordedImports(bytes, input.lock.recordedPropertyImports);
function outputCheck(filename) {
    assert(path.isAbsolute(filename) && filename === path.resolve(filename) && filename.startsWith(path.join(REPO, 'out') + path.sep),
        'Distribution owner must be canonical and under repository out/');
}
function checked(bytes, pin, reason) {
    assert.deepEqual(identity(bytes), { bytes: pin.bytes, sha256: pin.sha256 }, reason); return bytes;
}
async function inputs() {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const primaryBytes = await readRegular(path.join(HERE, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
    assert.equal(lock.kind, 'unreachable-distribution-path-source-profile'); assert.equal(lock.schemaVersion, 1);
    assert.deepEqual(lock.source, primary.source); assert.equal(lock.primaryClosureSha256, sha256(primaryBytes));
    assert.deepEqual(lock.targets.map(pin => pin.path), TARGETS); assert.deepEqual(lock.declarations, DECLARATIONS);
    assert.deepEqual(lock.symbols, SYMBOLS); assert.deepEqual(lock.facades, FACADES);
    for (const pin of [...lock.targets, lock.homonymConsumer, lock.deferredIncoming]) assert.deepEqual(pin, primary.files.find(row => row.path === pin.path));
    assert.equal(lock.homonymConsumer.path, HOMONYM); assert.equal(lock.deferredIncoming.path, DEFERRED);
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(HERE, pin.path), LIMIT), pin);
    assert.deepEqual(lock.recordedPropertyImports, JSON.parse(await readRegular(path.join(HERE, '../serializer-comment-type-names/sources.lock.json'))).recordedPropertyImports);
    return { lock, lockBytes, primary };
}
function homonym(bytes, input, assembled) {
    const canonical = assembled ? normalized(bytes, input) : bytes;
    checked(canonical, input.lock.homonymConsumer, 'Distribution exact IntelliJ homonym consumer body changed');
    assert.equal(canonical.toString().split('import com.intellij.util.PathUtil\n').length, 2, 'Distribution exact IntelliJ homonym import changed');
    assert.equal(canonical.toString().split('PathUtil.getFileName(container.fileName)').length, 2, 'Distribution exact IntelliJ basename call changed');
}
async function originalAudit(sourceRoot, input) {
    const inventory = input.primary.files.filter(pin => ['kotlin', 'java'].includes(pin.language));
    const originals = new Map(), incoming = [], allowedHomonyms = [], dynamicNames = [];
    for (let n = 0; n < inventory.length; n += 24) {
        const results = await Promise.allSettled(inventory.slice(n, n + 24).map(async pin => ({ pin,
            bytes: verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin) })));
        for (const result of results) {
            if (result.status !== 'fulfilled') throw result.reason;
            const { pin, bytes } = result.value, text = bytes.toString(), references = distributionReferences(text);
            if (TARGETS.includes(pin.path)) { distributionDeclarations(pin.path, text); originals.set(pin.path, bytes); }
            else if (pin.path === HOMONYM) { homonym(bytes, input, false); allowedHomonyms.push(pin.path); }
            else if (references.length) {
                assert.equal(pin.path, DEFERRED, 'Distribution unexpected primary incoming reference: ' + pin.path);
                verifyFile(bytes, input.lock.deferredIncoming); incoming.push({ path: pin.path, references, requiresVerifiedJvmUtilityExclusion: true });
            }
            dynamicNames.push(...distributionDynamicNames(pin.path, text));
        }
    }
    assert.equal(originals.size, 3); assert.deepEqual(allowedHomonyms, [HOMONYM]);
    assert.equal(incoming.length, 1, 'Distribution exact primary deferred incoming changed');
    return { originals, evidence: { inspectedFiles: inventory.length, inventorySha256: sha256(Buffer.from(JSON.stringify(inventory))),
        incoming, allowedHomonyms, dynamicNames } };
}
async function jvmBinding(component, input) {
    assert(component?.outputRoot && /^[a-f0-9]{64}$/.test(component.expectedReceiptSha256 ?? ''), 'Distribution external JVM utility receipt binding required');
    const outputRoot = path.resolve(component.outputRoot); outputCheck(outputRoot); await assertNoSymlink(outputRoot);
    const receiptPath = path.join(outputRoot, 'receipt.json'), receiptBytes = await readRegular(receiptPath, LIMIT);
    assert.equal(sha256(receiptBytes), component.expectedReceiptSha256, 'Distribution bound JVM utility receipt changed');
    const receipt = JSON.parse(receiptBytes), lockBytes = await readRegular(path.join(HERE, '../jvm-utility-source-profile/sources.lock.json'));
    const lock = JSON.parse(lockBytes);
    assert.equal(receipt.kind, 'unreachable-jvm-utility-source-selection'); assert.equal(receipt.sourceLockSha256, sha256(lockBytes));
    assert.deepEqual(receipt.source, input.lock.source); assert.deepEqual(receipt.targets, lock.targets);
    assert.deepEqual(receipt.sourceSetExclusions, lock.targets.map(pin => pin.path));
    assert.deepEqual(receipt.declarations, lock.declarations); assert.deepEqual(receipt.facades, lock.facades);
    assert.deepEqual(lock.targets.find(pin => pin.path === DEFERRED), input.lock.deferredIncoming);
    assert.equal(receipt.allOriginalsPreserved, true); assert.equal(receipt.jvmUtilitiesImplemented, false);
    for (const pin of lock.targets) verifyFile(await readRegular(path.join(outputRoot, 'original', pin.path)), pin);
    return { outputRoot, receiptPath, receiptSha256: component.expectedReceiptSha256, sourceLockSha256: receipt.sourceLockSha256,
        excludedPaths: receipt.sourceSetExclusions, deferredIncoming: input.lock.deferredIncoming };
}
async function selection(rows, input, before, binding) {
    assert(Array.isArray(rows) && rows.length > 0 && rows.length <= 20000, 'Distribution actual source vector required');
    const sources = [], paths = new Set(), owners = new Set(), dynamicNames = [], homonymConsumers = []; let inspectedBytes = 0;
    for (const row of rows) {
        relativePath(row.path); assert(/\.(?:kt|java)$/.test(row.path), 'Distribution source language changed'); outputCheck(row.filename);
        assert(row.compile !== false, 'Distribution actual source vector contains an inactive row');
        assert(!paths.has(row.path), 'Distribution duplicate logical path'); paths.add(row.path);
        assert(!owners.has(row.filename), 'Distribution duplicate physical owner'); owners.add(row.filename);
        assert(!TARGETS.some(target => row.path !== target && row.path.endsWith('/' + target)), 'Distribution excluded source relocated under a replacement path');
        assert(!binding.excludedPaths.includes(row.path), 'Distribution verified JVM exclusion reintroduced');
    }
    assert.equal(TARGETS.filter(target => paths.has(target)).length, before ? 3 : 0, 'Distribution exact three exclusion targets required');
    for (let n = 0; n < rows.length; n += 24) {
        const results = await Promise.allSettled(rows.slice(n, n + 24).map(async row => ({ row, bytes: await readRegular(row.filename) })));
        for (const result of results) {
            if (result.status !== 'fulfilled') throw result.reason;
            const { row, bytes } = result.value; checked(bytes, row, 'Distribution selected source bytes changed: ' + row.path);
            inspectedBytes += bytes.length; assert(inspectedBytes <= 512 * 1024 * 1024, 'Distribution source vector exceeds byte bound');
            if (TARGETS.includes(row.path)) verifyFile(normalized(bytes, input), input.lock.targets.find(pin => pin.path === row.path));
            else if (row.path === HOMONYM) { homonym(bytes, input, true); homonymConsumers.push({ ...row }); }
            else assert.deepEqual(distributionReferences(bytes.toString()), [], 'Distribution retained source refers to excluded distribution path declaration: ' + row.path);
            sources.push({ ...row }); dynamicNames.push(...distributionDynamicNames(row.path, bytes.toString()));
        }
    }
    assert.equal(homonymConsumers.length, 1, 'Distribution exact IntelliJ homonym consumer missing');
    return { sources, incoming: [], homonymConsumers, dynamicNames, inspectedBytes };
}
function receiptFor(input, sourceRoot, original, selected, binding) {
    return { schemaVersion: 1, kind: 'unreachable-distribution-path-source-selection', source: input.lock.source,
        sourceRoot, sourceLockSha256: sha256(input.lockBytes), targets: input.lock.targets, declarations: DECLARATIONS,
        symbols: SYMBOLS, facades: FACADES, originalAudit: original.evidence, selection: selected, jvmUtilityBinding: binding,
        sourceSetExclusions: TARGETS, commonSources: [], originalSourcesPreserved: true,
        boundary: 'After existing service-loader preparation; exact verified predecessor is used only by the four source-profile tail finals.',
        limitation: 'Conservative full-source identifier, alias, literal, Unicode and joined-name scan; arbitrary dynamic name computation and resolved IR reachability are not claimed.',
        filesystemImplemented: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareDistributionPathSourceProfile({ sourceRoot, outputRoot, retainedSources, preparedJvmUtilityProfile, recordedPropertyImports }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); outputCheck(outputRoot);
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Distribution profile roots overlap');
    const input = await inputs(); assert.deepEqual(recordedPropertyImports, input.lock.recordedPropertyImports, 'Distribution unrecorded property imports');
    const original = await originalAudit(sourceRoot, input), binding = await jvmBinding(preparedJvmUtilityProfile, input);
    const selected = await selection(retainedSources, input, true, binding), receipt = receiptFor(input, sourceRoot, original, selected, binding);
    for (const pin of input.lock.targets) {
        const predecessor = selected.sources.find(row => row.path === pin.path);
        for (const [directory, bytes] of [['original', original.originals.get(pin.path)], ['predecessor', await readRegular(predecessor.filename)]]) {
            const filename = path.join(outputRoot, directory, pin.path); await assertNoSymlink(filename);
            await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        }
    }
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath, LIMIT)), commonSources: [],
        sourceSetExclusions: TARGETS, originalReferenceSources: TARGETS.map(logical => path.join(outputRoot, 'original', logical)) };
}
async function replay({ sourceRoot, outputRoot, expectedReceiptSha256 }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); outputCheck(outputRoot);
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const input = await inputs(); assert.match(expectedReceiptSha256 ?? '', /^[a-f0-9]{64}$/, 'Distribution external receipt digest required');
    const bytes = await readRegular(path.join(outputRoot, 'receipt.json'), LIMIT);
    assert.equal(sha256(bytes), expectedReceiptSha256, 'Distribution preparation receipt changed');
    const receipt = JSON.parse(bytes); assert.equal(receipt.sourceRoot, sourceRoot, 'Distribution original source root changed');
    const original = await originalAudit(sourceRoot, input), binding = await jvmBinding({ outputRoot: receipt.jvmUtilityBinding.outputRoot,
        expectedReceiptSha256: receipt.jvmUtilityBinding.receiptSha256 }, input);
    const selected = await selection(receipt.selection.sources, input, true, binding);
    assert.deepEqual(receipt, receiptFor(input, sourceRoot, original, selected, binding), 'Distribution canonical preparation receipt changed');
    for (const pin of input.lock.targets) {
        verifyFile(await readRegular(path.join(outputRoot, 'original', pin.path)), pin);
        checked(await readRegular(path.join(outputRoot, 'predecessor', pin.path)), selected.sources.find(row => row.path === pin.path), 'Distribution exact predecessor snapshot changed');
    }
    return { input, receipt, outputRoot, binding };
}
export async function verifyDistributionPathSourceProfile(options) { return (await replay(options)).receipt; }
export async function verifyFinalDistributionPathSourceProfile({ retainedSources, ...options }) {
    const { input, receipt, outputRoot, binding } = await replay(options);
    const final = await selection(retainedSources, input, false, binding);
    const expected = receipt.selection.sources.filter(row => !TARGETS.includes(row.path));
    assert.deepEqual(final.sources, expected, 'Distribution final graph changed beyond exactly three exclusions');
    const replacements = new Map();
    for (const logical of TARGETS) {
        const row = receipt.selection.sources.find(item => item.path === logical);
        const bytes = checked(await readRegular(row.filename), row, 'Distribution original selected owner changed');
        assert.deepEqual(bytes, await readRegular(path.join(outputRoot, 'predecessor', logical)), 'Distribution original selected snapshot differs');
        verifyFile(normalized(bytes, input), input.lock.targets.find(pin => pin.path === logical)); replacements.set(logical, { ...row });
    }
    const actual = new Map(final.sources.map(row => [row.path, row]));
    const predecessorRetainedSources = receipt.selection.sources.map(row => replacements.get(row.path) ?? actual.get(row.path));
    assert.deepEqual(predecessorRetainedSources, receipt.selection.sources, 'Distribution predecessor order, owner or metadata changed');
    return { receipt: { schemaVersion: 1, kind: 'unreachable-distribution-path-final-selection', preparationReceiptSha256: options.expectedReceiptSha256,
        sourceLockSha256: sha256(input.lockBytes), selectedSources: final.sources.length, predecessorSources: predecessorRetainedSources.length,
        sourceSetExclusions: TARGETS, restoredPredecessors: [...replacements.values()], selectionSha256: sha256(Buffer.from(JSON.stringify(final.sources))),
        homonymConsumers: final.homonymConsumers, incoming: [], exactFullSourceBodiesAndOwnersVerified: true,
        everyOtherSourceAndCompleteRowMetadataUnchanged: true, predecessorRestorationVerified: true,
        filesystemImplemented: false, fullCompilerBuilt: false, languageReadiness: false }, predecessorRetainedSources };
}
