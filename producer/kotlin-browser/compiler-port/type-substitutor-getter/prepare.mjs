import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { maskCode } from '../descriptor-platform-signatures/transform.mjs';
import { verifyTypeImplementationPreparation } from '../type-implementation/prepare.mjs';
import { verifyDescriptorBaseImplementations } from '../descriptor-base-implementations/prepare.mjs';
import { canonicalVisitorValue, explicitValueParameterGetters } from '../descriptor-base-implementations/transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export const OUTPUT = 'compiler-port-type-substitutor-getter/TypeSubstitutorProperties.kt';
const TYPE = 'compiler-port-type-implementation/common/TypeSubstitutor.kt';
const ALIAS = 'compiler-port-type-implementation/common/TypeImplementationProperties.kt';
const VALUE = 'core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/ValueParameterDescriptorImpl.kt';
const ASSERTION = 'org.jetbrains.kotlin.portable.assertions.compilerAssert as assert';

function outputRootCheck(root) { assert(root.startsWith(path.join(REPO, 'out') + path.sep), 'Getter output must be under out/'); }
export function assembleImports(bytes, imports) {
    assert(Array.isArray(imports) && new Set(imports).size === imports.length && imports.every(name => typeof name === 'string' && /^[\w.*]+(?: as \w+)?$/.test(name)), 'Invalid recorded property imports');
    let code = bytes.toString();
    const add = block => {
        const declaration = /^package[ \t]+[^\r\n]+/m.exec(code); assert(declaration, 'Missing getter dependency package');
        const end = declaration.index + declaration[0].length; code = code.slice(0, end) + '\n' + block + '\n' + code.slice(end);
    };
    if (/@(?:\w+:)?(?:Jvm[A-Za-z]+|Volatile|Transient|Synchronized)\b/.test(code) && !/^import kotlin\.jvm\.\*\s*$/m.test(code)) add('import kotlin.jvm.*');
    const filtered = imports.filter(name => !code.includes('import ' + name));
    if (filtered.length) add(filtered.map(name => 'import ' + name).join('\n'));
    if (/\bassert\s*\(/.test(code) || /^import kotlin\.assert\s*$/m.test(code)) {
        assert(!/\bkotlin\.assert\s*\(/.test(code), 'Unreviewed qualified compiler assertion');
        code = code.replace(/^import kotlin\.assert[ \t]*\r?\n/gm, '');
        if (!code.split(/\r?\n/).some(line => line.trimEnd() === 'import ' + ASSERTION)) add('import ' + ASSERTION);
    }
    return Buffer.from(code);
}
export function calls(bytes) {
    const text = bytes.toString(), result = [];
    for (const match of maskCode(text).matchAll(/\b(?:substitutor|capturingSubstitutor)\s*\.\s*isEmpty\b(?!\s*\()/g)) {
        const start = text.lastIndexOf('\n', match.index) + 1, end = text.indexOf('\n', match.index);
        result.push({ expression: text.slice(match.index, match.index + match[0].length), context: text.slice(start, end < 0 ? text.length : end).trim() });
    }
    return result;
}
async function inputs(sourceRoot) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const primaryBytes = await readRegular(path.join(HERE, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
    assert.equal(lock.kind, 'actual-type-substitutor-getter'); assert.equal(lock.schemaVersion, 1);
    assert.deepEqual(lock.source, primary.source); assert.equal(lock.primaryClosureSha256, sha256(primaryBytes));
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    const originals = [];
    for (const pin of lock.originals) {
        assert.deepEqual(pin, primary.files.find(item => item.path === pin.path));
        originals.push(verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin));
    }
    const helper = verifyFile(await readRegular(path.join(HERE, lock.helper.path)), lock.helper);
    const canonical = new Map();
    for (const pin of lock.selected) {
        const bytes = pin.path === VALUE ? explicitValueParameterGetters(canonicalVisitorValue(await readRegular(path.join(sourceRoot, VALUE)),
            JSON.parse(await readRegular(path.join(HERE, '../descriptor-visitor-contract/sources.lock.json')))))
            : pin.localPath ? await readRegular(path.join(HERE, pin.localPath)) : await readRegular(path.join(sourceRoot, pin.path));
        canonical.set(pin.path, verifyFile(bytes, pin));
    }
    assert.equal(lock.selected.filter(pin => pin.calls.length).reduce((n, pin) => n + pin.calls.length, 0), 5);
    for (const pin of lock.selected) assert.deepEqual(calls(canonical.get(pin.path)), pin.calls, 'Observed getter call changed');
    return { lockBytes, lock, originals, helper, canonical };
}
async function inventory(retainedSources) {
    assert(Array.isArray(retainedSources) && retainedSources.length, 'Actual retained selection required');
    const paths = new Set(), filenames = new Set(), rows = [], observed = [];
    for (const item of retainedSources) {
        relativePath(item.path); assert(!paths.has(item.path), 'Duplicate selected logical path'); paths.add(item.path);
        assert(path.isAbsolute(item.filename) && !filenames.has(item.filename), 'Duplicate selected filename'); filenames.add(item.filename);
        const bytes = await readRegular(item.filename); assert.equal(bytes.length, item.bytes, 'Selected bytes changed'); assert.equal(sha256(bytes), item.sha256, 'Selected SHA changed');
        const row = { path: item.path, filename: item.filename, bytes: item.bytes, sha256: item.sha256 }; rows.push(row);
        if (item.path.endsWith('.kt')) { const found = calls(bytes); if (found.length) observed.push({ path: item.path, calls: found }); }
    }
    rows.sort((a, b) => a.path.localeCompare(b.path)); observed.sort((a, b) => a.path.localeCompare(b.path));
    return { rows, observed };
}
function expectedCalls(input) { return input.lock.selected.filter(pin => pin.calls.length).map(pin => ({ path: pin.path, calls: pin.calls })).sort((a, b) => a.path.localeCompare(b.path)); }
async function bind(input, component, kind, verifier) {
    assert(component?.outputRoot && component.receipt, 'Actual prepared dependency required');
    const root = path.resolve(component.outputRoot); outputRootCheck(root); await assertNoSymlink(root);
    await verifier(root);
    const receiptPath = path.join(root, 'receipt.json'), bytes = await readRegular(receiptPath), receipt = JSON.parse(bytes);
    assert.deepEqual(receipt, component.receipt, 'Prepared dependency object changed');
    assert.equal(receipt.kind, kind); assert.deepEqual(receipt.source, input.lock.source);
    return { outputRoot: root, receiptPath, receiptSha256: sha256(bytes), kind, sourceLockSha256: receipt.sourceLockSha256 };
}
function receiptFor(input, bindings, consumerBindings, selection) {
    return { schemaVersion: 1, kind: 'actual-type-substitutor-getter-preparation', source: input.lock.source, sourceLockSha256: sha256(input.lockBytes),
        files: [{ ...input.lock.helper, path: OUTPUT }], bindings, consumerBindings, selectedInventory: selection.rows, observedCalls: selection.observed,
        inventoryScope: 'Lexical substitutor/capturingSubstitutor.isEmpty properties outside comments and literals; no arbitrary alias or type-resolution claim.',
        replacedOriginalPaths: [], fullCompilerBuilt: false, fullCommonClassesWasmExecuted: false, languageReadiness: false };
}
async function checkBindings(input, bindings) {
    assert.equal(bindings.length, 2);
    for (const [i, binding] of bindings.entries()) {
        const expected = i === 0 ? ['official-type-implementation-port', '../type-implementation/sources.lock.json'] : ['genuine-descriptor-base-implementations-preparation', '../descriptor-base-implementations/sources.lock.json'];
        outputRootCheck(binding.outputRoot); assert.equal(binding.receiptPath, path.join(binding.outputRoot, 'receipt.json'));
        const bytes = await readRegular(binding.receiptPath), receipt = JSON.parse(bytes);
        assert.equal(sha256(bytes), binding.receiptSha256, 'Dependency receipt changed'); assert.equal(binding.kind, expected[0]); assert.equal(receipt.kind, binding.kind);
        assert.deepEqual(receipt.source, input.lock.source); assert.equal(receipt.sourceLockSha256, binding.sourceLockSha256);
        assert.equal(binding.sourceLockSha256, sha256(await readRegular(path.join(HERE, expected[1]))));
    }
}
function ownerFor(bindings, consumerBindings, logical) {
    if (logical === TYPE || logical === ALIAS) return path.join(bindings[0].outputRoot, 'common', path.basename(logical));
    if (logical === VALUE) return path.join(bindings[1].outputRoot, logical);
    const binding = consumerBindings.find(item => item.path === logical); assert(binding, 'Missing original consumer binding'); return binding.filename;
}
function bindOriginalConsumers(input, selection) {
    return input.lock.selected.filter(pin => pin.path !== TYPE && pin.path !== ALIAS && pin.path !== VALUE).map(pin => {
        const selected = selection.rows.find(item => item.path === pin.path); assert(selected, 'Missing original consumer selection');
        assert.equal(selected.bytes, pin.bytes); assert.equal(selected.sha256, pin.sha256); return { ...selected };
    });
}
async function validateRelevant(input, bindings, consumerBindings, selection, imports) {
    assert.deepEqual(selection.observed, expectedCalls(input), 'Unrecorded or missing selected getter calls');
    for (const pin of input.lock.selected) {
        const row = selection.rows.find(item => item.path === pin.path); assert(row, 'Missing genuine getter dependency');
        assert.equal(row.filename, ownerFor(bindings, consumerBindings, pin.path), 'Wrong genuine getter dependency owner');
        const actual = await readRegular(row.filename), canonical = input.canonical.get(pin.path);
        assert(actual.equals(canonical) || (imports && actual.equals(assembleImports(canonical, imports))), 'Genuine getter dependency body/imports changed: ' + pin.path);
    }
}
export async function prepareTypeSubstitutorGetter({ sourceRoot, outputRoot, retainedSources, preparedTypeImplementations, preparedDescriptorBases }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); outputRootCheck(outputRoot);
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Getter roots overlap');
    await assertNoSymlink(outputRoot); const input = await inputs(sourceRoot);
    const bindings = [await bind(input, preparedTypeImplementations, 'official-type-implementation-port', verifyTypeImplementationPreparation),
        await bind(input, preparedDescriptorBases, 'genuine-descriptor-base-implementations-preparation', verifyDescriptorBaseImplementations)];
    const selection = await inventory(retainedSources); await checkBindings(input, bindings);
    const consumerBindings = bindOriginalConsumers(input, selection);
    await validateRelevant(input, bindings, consumerBindings, selection);
    const receipt = { ...receiptFor(input, bindings, consumerBindings, selection), sourceRoot };
    for (const [i, pin] of input.lock.originals.entries()) {
        const filename = path.join(outputRoot, 'reference', pin.path); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, input.originals[i], { flag: 'wx', mode: 0o600 });
    }
    const filename = path.join(outputRoot, OUTPUT); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, input.helper, { flag: 'wx', mode: 0o600 });
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, commonSources: [filename], replacedOriginalPaths: [] };
}
async function replay(outputRoot) {
    outputRoot = path.resolve(outputRoot); outputRootCheck(outputRoot); await assertNoSymlink(outputRoot);
    const input = await inputs(path.join(outputRoot, 'reference')), stored = JSON.parse(await readRegular(path.join(outputRoot, 'receipt.json'), 64 * 1024 * 1024));
    await checkBindings(input, stored.bindings);
    assert(path.isAbsolute(stored.sourceRoot));
    const selection = { rows: stored.selectedInventory, observed: stored.observedCalls };
    assert.deepEqual(stored.consumerBindings, bindOriginalConsumers(input, selection), 'Original consumer binding changed');
    assert.deepEqual(stored, { ...receiptFor(input, stored.bindings, stored.consumerBindings, selection), sourceRoot: stored.sourceRoot }, 'Getter preparation receipt changed');
    assert.deepEqual(stored.observedCalls, expectedCalls(input));
    const paths = new Set(), filenames = new Set();
    for (const item of stored.selectedInventory) { relativePath(item.path); assert(!paths.has(item.path)); paths.add(item.path); assert(path.isAbsolute(item.filename) && !filenames.has(item.filename)); filenames.add(item.filename); }
    return { outputRoot, input, stored };
}
export async function verifyTypeSubstitutorGetter(outputRoot) {
    const { input, stored } = await replay(outputRoot);
    const selection = await inventory(stored.selectedInventory); assert.deepEqual(selection.rows, stored.selectedInventory);
    await validateRelevant(input, stored.bindings, stored.consumerBindings, selection);
    verifyFile(await readRegular(path.join(outputRoot, OUTPUT)), input.lock.helper);
    return stored;
}
export async function verifyFinalTypeSubstitutorGetter({ outputRoot, retainedSources, recordedPropertyImports = [] }) {
    const { input, stored } = await replay(outputRoot), selection = await inventory(retainedSources);
    await validateRelevant(input, stored.bindings, stored.consumerBindings, selection, recordedPropertyImports);
    const selected = selection.rows.find(item => item.path === OUTPUT); assert(selected, 'Missing typed getter output');
    assert.equal(selected.filename, path.join(path.resolve(outputRoot), OUTPUT), 'Wrong typed getter output owner');
    const bytes = await readRegular(selected.filename);
    assert(bytes.equals(input.helper) || bytes.equals(assembleImports(input.helper, recordedPropertyImports)), 'Typed getter output changed');
    return { schemaVersion: 1, kind: 'actual-type-substitutor-getter-final', sourceLockSha256: sha256(input.lockBytes),
        checked: selection.rows.filter(item => input.canonical.has(item.path) || item.path === OUTPUT), observedCalls: selection.observed,
        selectedSources: selection.rows.length, exactBodyAndImportsVerified: true, fullCompilerBuilt: false, languageReadiness: false };
}
