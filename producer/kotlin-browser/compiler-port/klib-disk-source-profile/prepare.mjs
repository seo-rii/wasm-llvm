import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { selectedDeclarations } from '../backend-profile/references.mjs';
import { normalizeImports } from '../klib-signature-index/transform.mjs';
import { verifyFinalKlibSignatureIndex } from '../klib-signature-index/prepare.mjs';
import { TARGET as SERVICE, verifyServiceLoaderFinalSources } from '../service-loader-profile/prepare.mjs';
import { CONFIG, TARGETS, DECLARATIONS, transformConfiguration, diskReferences } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
function rootCheck(root) { assert(path.isAbsolute(root) && root.startsWith(path.join(REPO, 'out') + path.sep), 'Disk profile output must stay under out/'); }
async function inputs() {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const primaryBytes = await readRegular(path.join(HERE, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'unreachable-klib-disk-source-profile');
    assert.deepEqual(lock.source, primary.source); assert.equal(lock.primaryClosureSha256, sha256(primaryBytes));
    assert.deepEqual(lock.targets.map(row => row.path), TARGETS); assert.deepEqual(lock.declarations, DECLARATIONS);
    for (const pin of [...lock.targets, lock.configuration.input]) assert.deepEqual(pin, primary.files.find(row => row.path === pin.path));
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    assert.deepEqual(lock.recordedPropertyImports, JSON.parse(await readRegular(path.join(HERE, '../serializer-comment-type-names/sources.lock.json'))).recordedPropertyImports);
    return { lock, lockBytes, primary };
}
function dynamicNames(logical, text) {
    return ['Class.forName', 'loadClass(', 'ServiceLoader', 'FileSystemProvider', 'META-INF/services'].filter(token => text.includes(token)).map(token => ({ path: logical, token }));
}
async function originalAudit(sourceRoot, i) {
    const pins = i.primary.files.filter(row => ['kotlin', 'java'].includes(row.language)), references = [], dynamic = [], preserved = new Map();
    for (let offset = 0; offset < pins.length; offset += 24) {
        const batch = await Promise.allSettled(pins.slice(offset, offset + 24).map(async pin => ({ pin, bytes: verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin) })));
        for (const result of batch) {
            if (result.status !== 'fulfilled') throw result.reason;
            const { pin, bytes } = result.value, text = bytes.toString(), found = diskReferences(text);
            if (found.length) references.push({ path: pin.path, references: found });
            dynamic.push(...dynamicNames(pin.path, text));
            if ([CONFIG, ...TARGETS].includes(pin.path)) preserved.set(pin.path, bytes);
            if (TARGETS.includes(pin.path)) assert.deepEqual(selectedDeclarations(text), i.lock.targetDeclarationInventory[pin.path]);
        }
    }
    assert.equal(preserved.size, 8);
    return { preserved, evidence: { inspectedFiles: pins.length, primaryKotlinSources: pins.filter(row => row.compile && row.language === 'kotlin').length,
        inventorySha256: sha256(Buffer.from(JSON.stringify(pins))), references, dynamicNames: dynamic } };
}
async function selected(retainedSources, i, phase, imports) {
    assert(Array.isArray(retainedSources) && retainedSources.length > 0 && retainedSources.length <= 20000);
    const sources = [], incoming = [], dynamic = [], boundaries = [], paths = new Set(), filenames = new Set(); let inspectedBytes = 0;
    for (let offset = 0; offset < retainedSources.length; offset += 24) {
        const batch = await Promise.allSettled(retainedSources.slice(offset, offset + 24).map(async item => ({ item, bytes: await readRegular(item.filename) })));
        for (const result of batch) {
            if (result.status !== 'fulfilled') throw result.reason;
            const { item, bytes } = result.value; relativePath(item.path); assert(/\.(?:kt|java)$/.test(item.path));
            assert(!paths.has(item.path), 'Duplicate disk profile logical path'); paths.add(item.path);
            rootCheck(item.filename); assert(!filenames.has(item.filename), 'Duplicate disk profile filename'); filenames.add(item.filename);
            assert.equal(bytes.length, item.bytes, 'Selected disk profile size changed'); assert.equal(sha256(bytes), item.sha256, 'Selected disk profile digest changed');
            inspectedBytes += bytes.length; assert(inspectedBytes <= 512 * 1024 * 1024);
            const target = i.lock.targets.find(row => row.path === item.path);
            const canonical = (target || item.path === CONFIG || i.lock.boundaries.some(row => row.path === item.path)) ? normalizeImports(bytes, imports) : null;
            if (target) {
                assert.equal(phase, 'before', 'Excluded KLIB disk source reintroduced'); verifyFile(canonical, target);
            } else {
                assert(!TARGETS.some(name => item.path.endsWith('/' + name)), 'Disk source copied under a replacement path');
                const auditedBytes = item.path === CONFIG && phase === 'before' ? transformConfiguration(bytes) : bytes;
                if (item.path === CONFIG) verifyFile(canonical, phase === 'before' ? i.lock.configuration.input : i.lock.configuration.output);
                const found = diskReferences(auditedBytes.toString()); if (found.length) incoming.push({ path: item.path, references: found });
            }
            const row = { path: item.path, filename: item.filename, ...identity(bytes) }; sources.push(row);
            const boundary = i.lock.boundaries.find(pin => pin.path === item.path);
            if (boundary) { assert.deepEqual(identity(canonical), { bytes: boundary.bytes, sha256: boundary.sha256 }, 'Genuine memory algorithm boundary changed: ' + item.path); boundaries.push(row); }
            dynamic.push(...dynamicNames(item.path, bytes.toString()));
        }
    }
    assert.equal(sources.filter(row => TARGETS.includes(row.path)).length, phase === 'before' ? 7 : 0, 'Exact seven disk targets required');
    assert.equal(sources.filter(row => row.path === CONFIG).length, 1, 'One exact KLIB configuration source is required');
    assert.equal(boundaries.length, i.lock.boundaries.length, 'Missing genuine memory algorithm boundary');
    assert.deepEqual(incoming, [], 'Actual source refers to excluded KLIB disk declaration');
    return { sources, incoming, dynamicNames: dynamic, boundaries, inspectedBytes };
}
async function indexBinding(component, sources, imports) {
    assert(component?.outputRoot && component.receiptPath, 'Actual prepared signature index component is required');
    const outputRoot = path.resolve(component.outputRoot), receiptPath = path.join(outputRoot, 'receipt.json'); rootCheck(outputRoot);
    assert.equal(path.resolve(component.receiptPath), receiptPath);
    const bytes = await readRegular(receiptPath); assert.deepEqual(JSON.parse(bytes), component.receipt, 'Signature index preparation object changed');
    const final = await verifyFinalKlibSignatureIndex({ outputRoot, retainedSources: sources, recordedPropertyImports: imports });
    return { outputRoot, receiptPath, receiptSha256: sha256(bytes), checked: final.receipt.checked };
}
export async function prepareKlibDiskSourceProfile({ sourceRoot, outputRoot, retainedSources, preparedKlibSignatureIndex, recordedPropertyImports }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); rootCheck(outputRoot); await assertNoSymlink(outputRoot); await assertNoSymlink(sourceRoot);
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Disk profile roots overlap');
    const i = await inputs(); assert.deepEqual(recordedPropertyImports, i.lock.recordedPropertyImports, 'Unrecorded disk assembly imports');
    const original = await originalAudit(sourceRoot, i), selection = await selected(retainedSources, i, 'before', recordedPropertyImports);
    const signatureIndex = await indexBinding(preparedKlibSignatureIndex, retainedSources, recordedPropertyImports);
    const before = selection.sources.find(row => row.path === CONFIG), bytes = transformConfiguration(await readRegular(before.filename));
    assert.deepEqual(transformConfiguration(bytes, true), await readRegular(before.filename));
    verifyFile(normalizeImports(bytes, recordedPropertyImports), i.lock.configuration.output);
    const filename = path.join(outputRoot, CONFIG), after = { path: CONFIG, filename, ...identity(bytes) };
    const receipt = { schemaVersion: 1, kind: 'unreachable-klib-disk-source-selection', source: i.lock.source, sourceLockSha256: sha256(i.lockBytes),
        originalAudit: original.evidence, targets: i.lock.targets, declarations: i.lock.declarations, sourceSetExclusions: TARGETS,
        configuration: { before, after, exactSpans: 3 }, signatureIndex, selection, recordedPropertyImports,
        limitation: 'Conservative lexical/literal closure; arbitrary dynamic name computation and compiler IR reachability are not claimed.',
        allOriginalsPreserved: true, memoryAlgorithmsRetained: true, zipRuntimeImplemented: false, fullCompilerBuilt: false, languageReadiness: false };
    for (const [logical, originalBytes] of original.preserved) {
        const destination = path.join(outputRoot, 'original', logical); await assertNoSymlink(destination);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }); await writeFile(destination, originalBytes, { flag: 'wx', mode: 0o600 });
    }
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath)), commonSources: [filename], sourceSetExclusions: TARGETS, replacedOriginalPaths: [CONFIG] };
}
export async function verifyKlibDiskFinalSources({ outputRoot, retainedSources, expectedReceiptSha256, serviceLoaderProfile = null }) {
    outputRoot = path.resolve(outputRoot); rootCheck(outputRoot); await assertNoSymlink(outputRoot);
    const i = await inputs(), receiptBytes = await readRegular(path.join(outputRoot, 'receipt.json'), 64 * 1024 * 1024);
    assert.match(expectedReceiptSha256 ?? '', /^[0-9a-f]{64}$/); assert.equal(sha256(receiptBytes), expectedReceiptSha256, 'Disk preparation receipt changed');
    const receipt = JSON.parse(receiptBytes); assert.equal(receipt.sourceLockSha256, sha256(i.lockBytes)); assert.deepEqual(receipt.sourceSetExclusions, TARGETS);
    assert.deepEqual(receipt.targets, i.lock.targets); assert.deepEqual(receipt.declarations, i.lock.declarations); assert.deepEqual(receipt.recordedPropertyImports, i.lock.recordedPropertyImports);
    for (const pin of [...i.lock.targets, i.lock.configuration.input]) verifyFile(await readRegular(path.join(outputRoot, 'original', pin.path)), pin);
    const indexBytes = await readRegular(receipt.signatureIndex.receiptPath); assert.equal(sha256(indexBytes), receipt.signatureIndex.receiptSha256, 'Bound signature index receipt changed');
    assert.equal(receipt.signatureIndex.receiptPath, path.join(receipt.signatureIndex.outputRoot, 'receipt.json'));
    const index = await verifyFinalKlibSignatureIndex({ outputRoot: receipt.signatureIndex.outputRoot, retainedSources, recordedPropertyImports: receipt.recordedPropertyImports });
    assert.deepEqual(index.receipt.checked, receipt.signatureIndex.checked, 'Bound signature index owners or bytes changed');
    let serviceFinal = null;
    const beforeService = receipt.selection.sources.filter(row => !TARGETS.includes(row.path)).map(row => row.path === CONFIG ? receipt.configuration.after : row);
    if (serviceLoaderProfile) {
        serviceFinal = await verifyServiceLoaderFinalSources({ ...serviceLoaderProfile, retainedSources });
        assert.deepEqual(serviceFinal.sourceSetExclusions, [SERVICE]);
        assert.equal(receipt.selection.sources.filter(row => row.path === SERVICE).length, 1, 'Subsequent service exclusion was absent in disk input');
        const serviceReceipt = JSON.parse(await readRegular(path.join(path.resolve(serviceLoaderProfile.outputRoot), 'service-loader-inputs.json'), 64 * 1024 * 1024));
        assert.deepEqual(serviceReceipt.selection.sources, beforeService, 'Service preparation did not receive the exact disk output graph');
    }
    const expected = beforeService.filter(row => !(serviceLoaderProfile && row.path === SERVICE));
    assert.equal(receipt.configuration.after.filename, path.join(outputRoot, CONFIG));
    assert.deepEqual(retainedSources.map(({ path, filename, bytes, sha256 }) => ({ path, filename, bytes, sha256 })), expected,
        'Final graph changed beyond seven disk exclusions, three config spans, and the verified service exclusion');
    const current = await selected(retainedSources, i, 'after', receipt.recordedPropertyImports);
    assert.deepEqual(current.sources, expected, 'Final graph changed beyond seven disk exclusions, three config spans, and the verified service exclusion');
    assert.deepEqual(current.boundaries, receipt.selection.boundaries, 'Genuine memory algorithm source owners changed');
    return { schemaVersion: 1, kind: 'unreachable-klib-disk-final-selection', preparationReceiptSha256: expectedReceiptSha256,
        sourceLockSha256: sha256(i.lockBytes), selectedSources: current.sources.length, sourceSetExclusions: TARGETS,
        configuration: receipt.configuration.after, incoming: current.incoming, dynamicNames: current.dynamicNames,
        boundaries: current.boundaries, selectionSha256: sha256(Buffer.from(JSON.stringify(current.sources))), serviceFinal,
        everyOtherSourceUnchanged: true, memoryAlgorithmsRetained: true, allOriginalsPreserved: true, zipRuntimeImplemented: false,
        fullCompilerBuilt: false, languageReadiness: false };
}
