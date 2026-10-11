import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { lexicalReferenceView, nativeOutputReferences } from '../native-js-output-profile/references.mjs';
import { selectedDeclarations } from '../backend-profile/references.mjs';
import { normalizeRecordedImports } from '../serializer-output-bindings/transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export const TARGET = 'compiler/frontend.common/src/org/jetbrains/kotlin/util/ServiceLoaderLite.kt';
export const REQUIRED = [
    'compiler/fir/raw-fir/mp-parsing2fir/src/org/jetbrains/kotlin/fir/builder/MultiplatformParsing2Fir.kt',
    'compiler/fir/fir2ir/src/org/jetbrains/kotlin/fir/backend/Fir2IrConverter.kt',
    'compiler/ir/backend.wasm/src/org/jetbrains/kotlin/backend/wasm/WasmLoweringPhases.kt',
    'core/descriptors/src/org/jetbrains/kotlin/builtins/BuiltInsLoader.kt',
];
const SYMBOLS = ['ServiceLoaderLite', 'ServiceLoadingException'];
const DECLARATION = { packageName: 'org.jetbrains.kotlin.util', name: SYMBOLS[0], kind: 'object' };
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });

// Conservative source references, including literal spellings and split literal names.
// This does not resolve arbitrary runtime string computation or prove an IR call graph.
export function serviceReferences(text) {
    const decoded = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    const view = lexicalReferenceView(decoded), reasons = nativeOutputReferences(decoded, DECLARATION, view);
    for (const symbol of SYMBOLS) {
        if (decoded.includes(symbol)) reasons.push('literal or identifier: ' + symbol);
        else if (view.replace(/[^A-Za-z0-9_]/g, '').includes(symbol)) reasons.push('conservatively joined name: ' + symbol);
    }
    return [...new Set(reasons)];
}

async function configuration() {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(lock.kind, 'unreachable-jvm-service-loader-profile');
    assert.deepEqual(lock.source, closure.source); assert.equal(lock.primaryClosureSha256, sha256(closureBytes));
    assert.deepEqual(lock.target, closure.files.find(pin => pin.path === TARGET));
    assert.deepEqual(lock.declarations, [DECLARATION]); assert.deepEqual(lock.requiredBoundaries, REQUIRED);
    for (const pin of lock.dependencies) assert.deepEqual(identity(await readRegular(path.join(HERE, pin.path))),
        { bytes: pin.bytes, sha256: pin.sha256 }, 'Pinned profile dependency changed: ' + pin.path);
    assert.equal(lock.preparationToolSha256, sha256(await readRegular(fileURLToPath(import.meta.url))));
    const serializerLock = JSON.parse(await readRegular(path.join(HERE, '../serializer-comment-type-names/sources.lock.json')));
    assert.deepEqual(lock.recordedPropertyImports, serializerLock.recordedPropertyImports);
    return { lock, lockBytes, closure };
}

function audit(source, text) {
    return ['ServiceLoader', 'Class.forName', 'loadClass(', 'META-INF/services'].filter(token => text.includes(token))
        .map(token => ({ path: source, token }));
}

async function originalInputs(sourceRoot, input) {
    sourceRoot = path.resolve(sourceRoot); await assertNoSymlink(sourceRoot);
    const pins = input.closure.files.filter(pin => ['kotlin', 'java'].includes(pin.language));
    const incoming = [], dynamicNames = []; let original;
    for (let start = 0; start < pins.length; start += 24) {
        const batch = await Promise.allSettled(pins.slice(start, start + 24).map(async pin => ({ pin,
            bytes: verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin) })));
        for (const result of batch) {
            if (result.status !== 'fulfilled') throw result.reason;
            const { pin, bytes } = result.value, text = bytes.toString();
            if (pin.path === TARGET) { original = bytes; assert.deepEqual(selectedDeclarations(text), [DECLARATION]); }
            else { const reasons = serviceReferences(text); if (reasons.length) incoming.push({ path: pin.path, reasons }); }
            dynamicNames.push(...audit(pin.path, text));
        }
    }
    assert(original); assert.deepEqual(incoming, [], 'Original source refers to excluded ServiceLoaderLite');
    return { original, inventory: pins, incoming, dynamicNames,
        primaryKotlinSources: pins.filter(pin => pin.compile && pin.language === 'kotlin').length };
}

async function selection(retainedSources, input, requireTarget) {
    assert(Array.isArray(retainedSources) && retainedSources.length > 0 && retainedSources.length <= 20000);
    const sources = [], incoming = [], dynamicNames = [], paths = new Set(), filenames = new Set(); let totalBytes = 0;
    const active = retainedSources.filter(pin => pin.compile !== false);
    for (let start = 0; start < active.length; start += 24) {
        const batch = await Promise.allSettled(active.slice(start, start + 24).map(async pin => ({ pin,
            bytes: await readRegular(path.resolve(pin.filename)) })));
        for (const result of batch) {
            if (result.status !== 'fulfilled') throw result.reason;
            const { pin, bytes } = result.value; relativePath(pin.path);
            assert(/\.(?:kt|java)$/.test(pin.path), 'Selected source must be Kotlin or Java');
            assert(!paths.has(pin.path), 'Duplicate selected logical source'); paths.add(pin.path);
            const filename = path.resolve(pin.filename); assert(filename.startsWith(path.join(REPO, 'out') + path.sep));
            assert(!filenames.has(filename), 'Duplicate selected physical source'); filenames.add(filename);
            totalBytes += bytes.length; assert(totalBytes <= 256 * 1024 * 1024);
            if (pin.bytes !== undefined) assert.equal(bytes.length, pin.bytes, 'Selected source byte length changed');
            if (pin.sha256 !== undefined) assert.equal(sha256(bytes), pin.sha256, 'Selected source hash changed');
            if (pin.path === TARGET) {
                assert(requireTarget, 'Excluded ServiceLoaderLite was reintroduced');
                verifyFile(normalizeRecordedImports(bytes, input.lock.recordedPropertyImports), input.lock.target);
            } else {
                assert(!pin.path.endsWith('/' + TARGET), 'Replacement ServiceLoaderLite was reintroduced');
                const reasons = serviceReferences(bytes.toString()); if (reasons.length) incoming.push({ path: pin.path, reasons });
            }
            sources.push({ path: pin.path, filename, ...identity(bytes) }); dynamicNames.push(...audit(pin.path, bytes.toString()));
        }
    }
    assert.deepEqual(incoming, [], 'Actual source refers to excluded ServiceLoaderLite');
    assert.equal(sources.filter(pin => pin.path === TARGET).length, requireTarget ? 1 : 0, 'Exact exclusion target selection required');
    const boundaries = REQUIRED.map(name => {
        const found = sources.filter(pin => pin.path === name || pin.path.endsWith('/' + name));
        assert.equal(found.length, 1, 'Required genuine algorithm boundary missing or duplicated: ' + name); return found[0];
    });
    return { sources, incoming, dynamicNames, boundaries, inspectedBytes: totalBytes };
}

export async function prepareServiceLoaderProfile({ sourceRoot, outputRoot, retainedSources }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep));
    await assertNoSymlink(outputRoot);
    const input = await configuration(), originals = await originalInputs(sourceRoot, input);
    const selected = await selection(retainedSources, input, true);
    const receipt = { schemaVersion: 1, kind: 'unreachable-service-loader-selection', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: input.lock.preparationToolSha256,
        target: input.lock.target, declarations: input.lock.declarations, originalReference: 'original/' + TARGET,
        originals: { inspectedFiles: originals.inventory.length, primaryKotlinSources: originals.primaryKotlinSources,
            inventorySha256: sha256(Buffer.from(JSON.stringify(originals.inventory))), incoming: originals.incoming, dynamicNames: originals.dynamicNames },
        selection: selected, sourceSetExclusions: [TARGET], commonSources: [],
        boundary: 'After source assembly, before final guards; every other selected path, physical owner and byte must remain identical.',
        limitation: 'Conservative lexical/literal references, not arbitrary runtime name resolution or an IR call graph.',
        serviceLoaderImplemented: false, compilerBuilt: false, languageReadiness: false };
    const originalPath = path.join(outputRoot, receipt.originalReference);
    await mkdir(path.dirname(originalPath), { recursive: true, mode: 0o700 });
    await writeFile(originalPath, originals.original, { flag: 'wx', mode: 0o600 });
    const receiptPath = path.join(outputRoot, 'service-loader-inputs.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, commonSources: [], sourceSetExclusions: [TARGET], originalReferenceSources: [originalPath],
        receipt, receiptPath, receiptSha256: sha256(await readRegular(receiptPath)) };
}

export async function verifyServiceLoaderFinalSources({ outputRoot, retainedSources, expectedReceiptSha256 }) {
    outputRoot = path.resolve(outputRoot); assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    await assertNoSymlink(outputRoot); const input = await configuration();
    assert.match(expectedReceiptSha256 ?? '', /^[0-9a-f]{64}$/, 'Original preparation receipt hash required');
    const receiptBytes = await readRegular(path.join(outputRoot, 'service-loader-inputs.json'));
    assert.equal(sha256(receiptBytes), expectedReceiptSha256, 'Preparation receipt changed');
    const receipt = JSON.parse(receiptBytes); assert.equal(receipt.sourceLockSha256, sha256(input.lockBytes));
    assert.deepEqual(receipt.target, input.lock.target); assert.deepEqual(receipt.sourceSetExclusions, [TARGET]);
    verifyFile(await readRegular(path.join(outputRoot, 'original', TARGET)), input.lock.target);
    const selected = await selection(retainedSources, input, false);
    assert.deepEqual(selected.sources, receipt.selection.sources.filter(pin => pin.path !== TARGET), 'Final graph changed beyond the one authorized exclusion');
    assert.deepEqual(selected.boundaries, receipt.selection.boundaries, 'Required core algorithm bytes changed');
    return { schemaVersion: 1, kind: 'unreachable-service-loader-final-selection', preparationReceiptSha256: expectedReceiptSha256,
        sourceLockSha256: sha256(input.lockBytes), sourceSetExclusions: [TARGET], selectedSources: selected.sources.length,
        selectionSha256: sha256(Buffer.from(JSON.stringify(selected.sources))), incoming: selected.incoming,
        dynamicNames: selected.dynamicNames, boundaries: selected.boundaries, originalSourcePreserved: true,
        everyOtherSourceUnchanged: true, serviceLoaderImplemented: false, compilerBuilt: false, languageReadiness: false };
}
