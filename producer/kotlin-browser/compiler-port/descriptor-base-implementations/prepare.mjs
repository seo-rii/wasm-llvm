import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

import { VALUE_PARAMETER, canonicalVisitorValue, explicitValueParameterGetters } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export function normalizeImports(bytes, recordedPropertyImports) {
    let text = bytes.toString();
    assert(Array.isArray(recordedPropertyImports));
    const markers = ['\nimport kotlin.jvm.*\n', '\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n'];
    if (recordedPropertyImports.length) markers.push('\n' + recordedPropertyImports.map(name => 'import ' + name).join('\n') + '\n');
    const seen = new Set();
    for (let step = 0; step < markers.length; step++) {
        const p = /^package[^\r\n]+/m.exec(text); assert(p, 'Missing descriptor base package');
        const end = p.index + p[0].length, marker = markers.find(value => text.startsWith(value, end));
        if (!marker) break;
        assert(!seen.has(marker), 'Duplicate descriptor base assembly imports'); seen.add(marker);
        text = text.slice(0, end) + text.slice(end + marker.length);
    }
    return Buffer.from(text);
}
async function load(sourceRoot) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const primaryBytes = await readRegular(path.join(HERE, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
    assert.equal(lock.kind, 'genuine-descriptor-base-implementations'); assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.primaryClosureSha256, sha256(primaryBytes)); assert.deepEqual(lock.source, primary.source);
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    const originals = [];
    for (const pin of lock.originals) {
        assert.deepEqual(pin, primary.files.find(item => item.path === pin.path));
        originals.push(verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin));
    }
    const common = [];
    for (const pin of lock.common) common.push(verifyFile(await readRegular(path.join(HERE, pin.path)), pin));
    const visitorLockBytes = await readRegular(path.join(HERE, '../descriptor-visitor-contract/sources.lock.json')), visitorLock = JSON.parse(visitorLockBytes);
    const original = originals[lock.originals.findIndex(pin => pin.path === VALUE_PARAMETER)];
    const predecessorBytes = canonicalVisitorValue(original, visitorLock), consumer = explicitValueParameterGetters(predecessorBytes);
    verifyFile(predecessorBytes, lock.consumer.input); verifyFile(consumer, lock.consumer.output);
    return { lock, lockBytes, originals, common, visitorLock, visitorLockBytes, predecessorBytes, consumer };
}
function roots(sourceRoot, outputRoot) {
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep), 'Descriptor base output must be under out/');
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Descriptor base roots overlap');
}
function receiptFor(input, binding) {
    return { schemaVersion: 1, kind: 'genuine-descriptor-base-implementations-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), originals: input.lock.originals,
        files: [...input.lock.common.map(pin => ({ ...pin, path: pin.outputPath })), input.lock.consumer.output],
        predecessorBinding: binding, valueParameterExplicitGetterSpans: 2,
        implementationClasses: ['DeclarationDescriptorImpl', 'DeclarationDescriptorNonRootImpl', 'VariableDescriptorImpl'],
        requiredHost: 'Actual descriptor class simple name and identity hash; request-scoped with previous host restored in finally.',
        declaredNonNullContract: true, assertionsEnabled: true, nullOnlyVoid: true,
        rawJavaNullConstructionParity: false, rawNullTypeBeforeInitializationParity: false,
        fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareDescriptorBaseImplementations({ sourceRoot, outputRoot, descriptorVisitorComponent, retainedSources }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); roots(sourceRoot, outputRoot);
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const input = await load(sourceRoot), commonSources = [];
    assert(descriptorVisitorComponent && Array.isArray(retainedSources), 'Descriptor visitor component and actual selection required');
    const predecessorRoot = path.dirname(path.resolve(descriptorVisitorComponent.receiptPath));
    const receiptBytes = await readRegular(path.join(predecessorRoot, 'receipt.json')), previous = JSON.parse(receiptBytes);
    assert.deepEqual(previous, descriptorVisitorComponent.receipt, 'Descriptor visitor receipt object changed');
    assert.equal(previous.kind, 'selected-descriptor-visitor-null-dispatch-preparation');
    assert.equal(previous.sourceLockSha256, sha256(input.visitorLockBytes));
    assert.deepEqual(previous.files.find(pin => pin.path === VALUE_PARAMETER), (({gitBlob, ...pin}) => pin)(input.lock.consumer.input));
    const filename = path.join(predecessorRoot, VALUE_PARAMETER);
    assert.equal(descriptorVisitorComponent.commonSources.filter(item => item === filename).length, 1, 'Missing canonical visitor source owner');
    const selected = retainedSources.filter(item => item.path === VALUE_PARAMETER);
    assert.equal(selected.length, 1, 'Value parameter predecessor selection must be unique');
    assert.equal(selected[0].filename, filename, 'Wrong value parameter predecessor owner');
    assert.equal(retainedSources.filter(item => item.filename === filename).length, 1, 'Duplicated value parameter predecessor filename');
    const bytes = verifyFile(await readRegular(filename), input.lock.consumer.input);
    assert.equal(selected[0].bytes, bytes.length); assert.equal(selected[0].sha256, sha256(bytes));
    const binding = { component: 'descriptorVisitorReceipt', componentRelativePath: VALUE_PARAMETER, filename,
        bytes: bytes.length, sha256: sha256(bytes), receiptPath: path.join(predecessorRoot, 'receipt.json'), receiptSha256: sha256(receiptBytes) };
    const receipt = receiptFor(input, binding);
    for (const [index, pin] of input.lock.originals.entries()) {
        const filename = path.join(outputRoot, 'reference', pin.path); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, input.originals[index], { flag: 'wx', mode: 0o600 });
    }
    for (const [index, pin] of receipt.files.entries()) {
        const filename = path.join(outputRoot, relativePath(pin.path)); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, index < input.common.length ? input.common[index] : input.consumer, { flag: 'wx', mode: 0o600 }); commonSources.push(filename);
    }
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, commonSources, predecessorBindings: [binding], replacedOriginalPaths: input.lock.originals.filter(pin => pin.language === 'java' && /\/impl\/(?:DeclarationDescriptorImpl|DeclarationDescriptorNonRootImpl|VariableDescriptorImpl)\.java$/.test(pin.path)).map(pin => pin.path).concat(VALUE_PARAMETER) };
}
export async function verifyDescriptorBaseImplementations(outputRoot) {
    outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot);
    const sourceRoot = path.join(outputRoot, 'reference'), input = await load(sourceRoot);
    const stored = JSON.parse(await readRegular(path.join(outputRoot, 'receipt.json'))), receipt = receiptFor(input, await replayBinding(input, stored.predecessorBinding));
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    assert.deepEqual(JSON.parse(await readRegular(path.join(outputRoot, 'receipt.json'))), receipt, 'Descriptor base preparation receipt changed');
    for (const pin of receipt.files) verifyFile(await readRegular(path.join(outputRoot, pin.path)), pin);
    return receipt;
}
export async function verifyFinalDescriptorBaseImplementations({ outputRoot, retainedSources, recordedPropertyImports = [] }) {
    outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    const input = await load(path.join(outputRoot, 'reference'));
    const stored = JSON.parse(await readRegular(path.join(outputRoot, 'receipt.json'))), receipt = receiptFor(input, await replayBinding(input, stored.predecessorBinding));
    assert.deepEqual(JSON.parse(await readRegular(path.join(outputRoot, 'receipt.json'))), receipt, 'Descriptor base preparation receipt changed');
    assert(Array.isArray(retainedSources) && retainedSources.length, 'Descriptor base final selection required');
    const paths = new Set(), filenames = new Set(), checked = [], predecessorRetainedSources = [];
    for (const item of retainedSources) {
        relativePath(item.path); assert(!paths.has(item.path), 'Duplicate descriptor base selection path'); paths.add(item.path);
        assert(path.isAbsolute(item.filename) && !filenames.has(item.filename), 'Duplicate descriptor base selection filename'); filenames.add(item.filename);
        assert(!receipt.originals.some(pin => pin.language === 'java' && pin.path === item.path), 'Java descriptor base was reintroduced');
        const pin = receipt.files.find(pin => pin.path === item.path);
        if (!pin) { predecessorRetainedSources.push(item); continue; }
        assert.equal(item.filename, path.join(outputRoot, pin.path), 'Wrong descriptor base source owner');
        const bytes = await readRegular(item.filename);
        assert.equal(bytes.length, item.bytes, 'Descriptor base final size mismatch'); assert.equal(sha256(bytes), item.sha256, 'Descriptor base final hash mismatch');
        verifyFile(normalizeImports(bytes, recordedPropertyImports), pin); checked.push(item);
        if (item.path === VALUE_PARAMETER) { const previous = receipt.predecessorBinding; predecessorRetainedSources.push({ path: VALUE_PARAMETER, filename: previous.filename, bytes: previous.bytes, sha256: previous.sha256 }); }
    }
    assert.equal(checked.length, receipt.files.length, 'Missing descriptor base final source');
    return { receipt: { schemaVersion: 1, kind: 'genuine-descriptor-base-implementations-final', sourceLockSha256: sha256(input.lockBytes),
        checked, exactBodyAndImportsVerified: true, fullCompilerBuilt: false, languageReadiness: false }, predecessorRetainedSources };
}

async function replayBinding(input, binding) {
    assert.equal(binding.component, 'descriptorVisitorReceipt'); assert.equal(binding.componentRelativePath, VALUE_PARAMETER);
    assert(path.isAbsolute(binding.receiptPath) && binding.receiptPath.startsWith(path.join(REPO, 'out') + path.sep));
    assert.equal(path.basename(binding.receiptPath), 'receipt.json');
    assert.equal(binding.filename, path.join(path.dirname(binding.receiptPath), VALUE_PARAMETER));
    const receiptBytes = await readRegular(binding.receiptPath); assert.equal(sha256(receiptBytes), binding.receiptSha256, 'Descriptor visitor receipt changed after binding');
    const previous = JSON.parse(receiptBytes);
    assert.equal(previous.kind, 'selected-descriptor-visitor-null-dispatch-preparation');
    assert.equal(previous.sourceLockSha256, sha256(input.visitorLockBytes));
    assert.deepEqual(previous.files.find(pin => pin.path === VALUE_PARAMETER), (({gitBlob, ...pin}) => pin)(input.lock.consumer.input));
    verifyFile(await readRegular(binding.filename), input.lock.consumer.input);
    assert.equal(binding.bytes, input.lock.consumer.input.bytes); assert.equal(binding.sha256, input.lock.consumer.input.sha256);
    return binding;
}
