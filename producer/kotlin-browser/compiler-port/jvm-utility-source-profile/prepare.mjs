import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { normalizeRecordedImports } from '../serializer-output-bindings/transform.mjs';
import { verifyKlibDiskFinalSources } from '../klib-disk-source-profile/prepare.mjs';
import { DECLARATIONS, FACADES, REQUIRED, TARGETS, utilityDeclarations, utilityReferences, dynamicNames } from './references.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const RECEIPT_LIMIT = 64 * 1024 * 1024;
function outputCheck(root) { assert(path.isAbsolute(root) && root.startsWith(path.join(REPO, 'out') + path.sep), 'Utility output/owner must stay under repository out/'); }

async function inputs() {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'unreachable-jvm-utility-source-profile');
    assert.deepEqual(lock.source, closure.source); assert.equal(lock.primaryClosureSha256, sha256(closureBytes));
    assert.deepEqual(lock.targets.map(row => row.path), TARGETS); assert.deepEqual(lock.declarations, DECLARATIONS);
    assert.deepEqual(lock.facades, FACADES); assert.deepEqual(lock.requiredBoundaries, REQUIRED);
    for (const pin of lock.targets) assert.deepEqual(pin, closure.files.find(row => row.path === pin.path));
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    assert.deepEqual(lock.recordedPropertyImports, JSON.parse(await readRegular(path.join(HERE, '../serializer-comment-type-names/sources.lock.json'))).recordedPropertyImports);
    return { lock, lockBytes, closure };
}

async function originalAudit(sourceRoot, input) {
    const inventory = input.closure.files.filter(row => ['kotlin', 'java'].includes(row.language));
    const references = [], dynamic = [], originals = new Map();
    for (let n = 0; n < inventory.length; n += 24) {
        const batch = await Promise.allSettled(inventory.slice(n, n + 24).map(async pin => ({ pin,
            bytes: verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin) })));
        for (const result of batch) {
            if (result.status !== 'fulfilled') throw result.reason;
            const { pin, bytes } = result.value, text = bytes.toString(), found = utilityReferences(text);
            if (found.length) references.push({ path: pin.path, references: found });
            dynamic.push(...dynamicNames(pin.path, text));
            if (TARGETS.includes(pin.path)) { utilityDeclarations(pin.path, text); originals.set(pin.path, bytes); }
        }
    }
    assert.equal(originals.size, TARGETS.length);
    return { originals, evidence: { inspectedFiles: inventory.length,
        primaryKotlinSources: inventory.filter(row => row.compile && row.language === 'kotlin').length,
        inventorySha256: sha256(Buffer.from(JSON.stringify(inventory))), references, dynamicNames: dynamic } };
}

async function selected(retainedSources, input, before) {
    assert(Array.isArray(retainedSources) && retainedSources.length > 0 && retainedSources.length <= 20000);
    const active = retainedSources.filter(row => row.compile !== false);
    const sources = [], dynamic = [], paths = new Set(), filenames = new Set(); let inspectedBytes = 0;
    for (const row of active) {
        relativePath(row.path); assert(/\.(?:kt|java)$/.test(row.path));
        assert(!paths.has(row.path), 'Duplicate utility profile logical path'); paths.add(row.path);
        assert.equal(row.filename, path.resolve(row.filename), 'Canonical absolute physical owner required'); outputCheck(row.filename);
        assert(!filenames.has(row.filename), 'Duplicate utility profile physical owner'); filenames.add(row.filename);
        if (!TARGETS.includes(row.path)) assert(!TARGETS.some(target => row.path.endsWith('/' + target)), 'Excluded utility copied under a replacement path');
    }
    assert.equal(TARGETS.filter(target => paths.has(target)).length, before ? TARGETS.length : 0, 'Exact five utility targets required before preparation and absent afterwards');
    for (let n = 0; n < active.length; n += 24) {
        const batch = await Promise.allSettled(active.slice(n, n + 24).map(async row => ({ row, bytes: await readRegular(row.filename) })));
        for (const result of batch) {
            if (result.status !== 'fulfilled') throw result.reason;
            const { row, bytes } = result.value;
            assert.equal(bytes.length, row.bytes, 'Selected utility source length changed');
            assert.equal(sha256(bytes), row.sha256, 'Selected utility source hash changed');
            inspectedBytes += bytes.length; assert(inspectedBytes <= 512 * 1024 * 1024);
            if (TARGETS.includes(row.path)) verifyFile(normalizeRecordedImports(bytes, input.lock.recordedPropertyImports), input.lock.targets.find(pin => pin.path === row.path));
            else assert.deepEqual(utilityReferences(bytes.toString()), [], 'Actual selected source refers to an excluded JVM utility: ' + row.path);
            sources.push({ path: row.path, filename: row.filename, ...identity(bytes) }); dynamic.push(...dynamicNames(row.path, bytes.toString()));
        }
    }
    const boundaries = REQUIRED.map(logical => {
        const found = sources.filter(row => row.path === logical || row.path.endsWith('/' + logical));
        assert.equal(found.length, 1, 'Required reached algorithm boundary missing or duplicated: ' + logical); return found[0];
    });
    return { sources, incoming: [], dynamicNames: dynamic, boundaries, inspectedBytes };
}

export async function prepareJvmUtilitySourceProfile({ sourceRoot, outputRoot, retainedSources }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); outputCheck(outputRoot);
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Utility profile roots overlap');
    const input = await inputs(), original = await originalAudit(sourceRoot, input), selection = await selected(retainedSources, input, true);
    const receipt = { schemaVersion: 1, kind: 'unreachable-jvm-utility-source-selection', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), targets: input.lock.targets, declarations: DECLARATIONS, facades: FACADES,
        originalAudit: original.evidence, selection, sourceSetExclusions: TARGETS, commonSources: [],
        boundary: 'After assembly, immediately before the verified disk/service source profiles.',
        limitation: 'Conservative source, identifier, literal and facade scan; arbitrary dynamic name computation and compiler IR reachability are not claimed.',
        allOriginalsPreserved: true, reachedPathUtilitiesRetained: true, jvmUtilitiesImplemented: false, fullCompilerBuilt: false, languageReadiness: false };
    for (const [logical, bytes] of original.originals) {
        const filename = path.join(outputRoot, 'original', logical); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    }
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath, RECEIPT_LIMIT)),
        commonSources: [], sourceSetExclusions: TARGETS, originalReferenceSources: TARGETS.map(logical => path.join(outputRoot, 'original', logical)) };
}

export async function verifyJvmUtilityFinalSources({ outputRoot, retainedSources, expectedReceiptSha256, klibDiskProfile = null }) {
    outputRoot = path.resolve(outputRoot); outputCheck(outputRoot); await assertNoSymlink(outputRoot);
    const input = await inputs(); assert.match(expectedReceiptSha256 ?? '', /^[0-9a-f]{64}$/, 'Original utility preparation receipt digest required');
    const receiptBytes = await readRegular(path.join(outputRoot, 'receipt.json'), RECEIPT_LIMIT);
    assert.equal(sha256(receiptBytes), expectedReceiptSha256, 'Utility preparation receipt changed');
    const receipt = JSON.parse(receiptBytes); assert.equal(receipt.sourceLockSha256, sha256(input.lockBytes));
    assert.deepEqual(receipt.targets, input.lock.targets); assert.deepEqual(receipt.declarations, DECLARATIONS);
    assert.deepEqual(receipt.facades, FACADES); assert.deepEqual(receipt.sourceSetExclusions, TARGETS);
    for (const pin of input.lock.targets) verifyFile(await readRegular(path.join(outputRoot, 'original', pin.path)), pin);
    let diskFinal = null, predecessorSources;
    if (klibDiskProfile) {
        diskFinal = await verifyKlibDiskFinalSources({ ...klibDiskProfile, retainedSources });
        const diskBytes = await readRegular(path.join(path.resolve(klibDiskProfile.outputRoot), 'receipt.json'), RECEIPT_LIMIT);
        assert.equal(sha256(diskBytes), klibDiskProfile.expectedReceiptSha256, 'Bound disk receipt changed');
        predecessorSources = JSON.parse(diskBytes).selection.sources;
    }
    const final = await selected(retainedSources, input, false);
    const expected = receipt.selection.sources.filter(row => !TARGETS.includes(row.path));
    assert.deepEqual(predecessorSources ?? final.sources, expected, 'Final graph changed beyond exactly five utility exclusions and verified downstream disk/service composition');
    assert.deepEqual(final.boundaries, receipt.selection.boundaries, 'Reached algorithm boundary owner or bytes changed');
    return { schemaVersion: 1, kind: 'unreachable-jvm-utility-final-selection', preparationReceiptSha256: expectedReceiptSha256,
        sourceLockSha256: sha256(input.lockBytes), sourceSetExclusions: TARGETS, selectedSources: final.sources.length,
        selectionSha256: sha256(Buffer.from(JSON.stringify(final.sources))), incoming: final.incoming, dynamicNames: final.dynamicNames,
        boundaries: final.boundaries, diskFinal, allOriginalsPreserved: true, everyOtherSourceUnchangedExceptVerifiedProfiles: true,
        reachedPathUtilitiesRetained: true, jvmUtilitiesImplemented: false, fullCompilerBuilt: false, languageReadiness: false };
}
