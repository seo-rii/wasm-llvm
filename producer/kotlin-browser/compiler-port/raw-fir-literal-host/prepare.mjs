import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { lexicalReferenceView } from '../native-js-output-profile/references.mjs';
import { TARGET, HELPERS, RECIPE, NUMERIC_RECIPE, transformRawFirLiteral, extractLiteralHelpers, normalizeRawFirImports } from './transform.mjs';
import { prepareRawFirLiteralSourceCache } from './fetch.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const HOST = 'compiler/frontend.common/src/org/jetbrains/kotlin/KtSourceElement.kt';
const PARSER_HELPER = 'compiler-port-parser-profile/ParserProfile.kt';
const project = ({ path, filename, bytes, sha256 }) => ({ path, filename, bytes, sha256 });
function roots(sourceRoot, outputRoot) {
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep), 'Raw FIR output must be under out/');
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Raw FIR input/output overlap');
}
async function inputs() {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'genuine-raw-fir-literal-light-node-host');
    assert.equal(lock.primaryClosureSha256, sha256(closureBytes)); assert.deepEqual(lock.source, closure.source);
    assert.deepEqual(lock.original, closure.files.find(row => row.path === TARGET));
    assert.deepEqual(lock.numbers, closure.files.find(row => row.path === lock.numbers.path));
    assert.deepEqual(lock.recipe, RECIPE); assert.deepEqual(lock.numericRecipe, NUMERIC_RECIPE);
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.resolve(HERE, pin.path)), pin);
    return { lockBytes, lock };
}
async function originalInputs(sourceRoot, supplementalSourceRoot, input) {
    const original = verifyFile(await readRegular(path.join(sourceRoot, TARGET)), input.lock.original);
    const numbers = verifyFile(await readRegular(path.join(sourceRoot, input.lock.numbers.path)), input.lock.numbers);
    const supplemental = [];
    for (const pin of input.lock.supplementalSources) supplemental.push(verifyFile(await readRegular(path.join(supplementalSourceRoot, pin.path)), pin));
    const common = verifyFile(transformRawFirLiteral(original), input.lock.output);
    const helpers = verifyFile(extractLiteralHelpers(...supplemental), input.lock.helpers);
    assert.deepEqual(await readRegular(path.join(HERE, 'RawFirLiteralHelpers.kt')), helpers);
    return { original, numbers, supplemental, common, helpers };
}
async function selected(rows, outputRoot, input, originals, imports, final, beforeBoundaries = []) {
    assert(Array.isArray(rows) && rows.length && rows.length <= 20000, 'Actual raw FIR selection required');
    const paths = new Set(), owners = new Set(), boundaries = [], checked = [], references = [];
    for (let offset = 0; offset < rows.length; offset += 24) {
        const results = await Promise.allSettled(rows.slice(offset, offset + 24).map(async row => ({ row, bytes: await readRegular(row.filename) })));
        for (const result of results) {
            if (result.status !== 'fulfilled') throw result.reason;
            const { row, bytes } = result.value;
            relativePath(row.path); assert(!paths.has(row.path), 'Duplicate raw FIR logical path'); paths.add(row.path);
            assert(path.isAbsolute(row.filename) && !owners.has(row.filename), 'Duplicate raw FIR physical owner'); owners.add(row.filename);
            assert.equal(bytes.length, row.bytes); assert.equal(sha256(bytes), row.sha256, 'Raw FIR selected row body changed');
            const view = lexicalReferenceView(bytes.toString()), names = input.lock.referenceNames.filter(name => new RegExp('\\b' + name + '\\b').test(view));
            assert(!/\b(?:class|interface|object|typealias)\s+PsiElement\b/u.test(view), 'Selected PSI type/shadow invalidates the raw FIR LightNode profile');
            const boundary = input.lock.boundaries.find(pin => pin.path === row.path);
            if (names.length) {
                assert(row.path === TARGET || boundary, 'New raw FIR builder caller/shadow requires review: ' + row.path);
                references.push({ path: row.path, names });
            }
            if (boundary) {
                const canonicalSnapshot = final ? await readRegular(path.join(outputRoot, 'boundaries', row.path)) : undefined;
                const canonical = normalizeRawFirImports(bytes, canonicalSnapshot ?? Buffer.from('package canonical'), imports);
                verifyFile(canonical, boundary);
                if (final) assert.equal(row.filename, beforeBoundaries.find(pin => pin.path === row.path)?.filename, 'Raw FIR host/caller owner changed');
                boundaries.push({ ...project(row), canonical });
            }
            if (row.path === TARGET || row.path === HELPERS) {
                const pin = row.path === TARGET ? (final ? input.lock.output : input.lock.original) : input.lock.helpers;
                const canonical = row.path === TARGET ? (final ? originals.common : originals.original) : originals.helpers;
                assert(final || row.path !== HELPERS, 'Raw FIR helpers already selected');
                verifyFile(normalizeRawFirImports(bytes, canonical, imports), pin);
                if (final) assert.equal(row.filename, path.join(outputRoot, row.path), 'Wrong raw FIR output owner');
                checked.push(project(row));
            }
        }
    }
    assert.equal(boundaries.length, input.lock.boundaries.length, 'Missing complete raw FIR host/caller/helper boundary');
    assert.equal(checked.length, final ? 2 : 1, 'Missing complete raw FIR selected output');
    const canonicalHost = boundaries.find(row => row.path === HOST).canonical.toString();
    assert(canonicalHost.includes('sealed class KtSourceElement : AbstractKtSourceElement()'));
    assert.equal([...canonicalHost.matchAll(/: KtSourceElement\(/g)].length, 1);
    assert(canonicalHost.includes('class KtLightSourceElement(') && !/class Kt\w*PsiSourceElement/u.test(canonicalHost));
    const lightTree = boundaries.find(row => row.path.endsWith('/LightSyntaxTree.kt')).canonical.toString();
    assert(lightTree.includes('value class LightNode(val index: Int)'));
    const mpBuilder = boundaries.find(row => row.path.endsWith('/AbstractMultiplatformParsingRawFirBuilder.kt')).canonical.toString();
    assert(mpBuilder.includes(': AbstractTreeRawFirBuilder<LightNode, SyntaxElementType>'));
    return { checked, boundaries, references };
}
async function binding(prepared, kind, selectedSource, helper, expectedReceiptPins = undefined) {
    assert(prepared?.receiptPath && prepared.receipt && Array.isArray(prepared.commonSources), 'Genuine prepared raw FIR predecessor required');
    const bytes = await readRegular(prepared.receiptPath), receipt = JSON.parse(bytes);
    assert.deepEqual(receipt, prepared.receipt); assert.equal(receipt.kind, kind);
    assert(prepared.commonSources.includes(selectedSource.filename), 'Raw FIR predecessor selected owner mismatch');
    const pin = helper ? receipt.portable.find(row => row.path === 'ParserProfile.kt') : receipt.sources.find(row => row.path === HOST);
    const canonical = selectedSource.canonical; assert.equal(canonical.length, pin.bytes); assert.equal(sha256(canonical), pin.sha256);
    if (expectedReceiptPins) assert.equal(receipt.sourceLockSha256, expectedReceiptPins);
    return { receiptPath: prepared.receiptPath, receiptSha256: sha256(bytes), selectedOwner: selectedSource.filename };
}
export async function prepareRawFirLiteralHost({ sourceRoot, outputRoot, retainedSources, preparedHost, preparedParserProfile, recordedPropertyImports = [], supplementalSourceRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); roots(sourceRoot, outputRoot);
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const input = await inputs();
    supplementalSourceRoot = path.resolve(supplementalSourceRoot ?? (await prepareRawFirLiteralSourceCache()).sourceRoot);
    const originals = await originalInputs(sourceRoot, supplementalSourceRoot, input);
    const selection = await selected(retainedSources, outputRoot, input, originals, recordedPropertyImports, false);
    const hostLock = await readRegular(path.join(HERE, '../host/sources.lock.json'));
    const host = await binding(preparedHost, 'official-compiler-portable-source-host-preparation', selection.boundaries.find(row => row.path === HOST), false, sha256(hostLock));
    const parser = await binding(preparedParserProfile, 'official-new-parser-only-source-profile', selection.boundaries.find(row => row.path === PARSER_HELPER), true);
    async function store(logical, bytes) {
        const filename = path.join(outputRoot, relativePath(logical)); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename;
    }
    await store('original/' + TARGET, originals.original); await store('original/' + input.lock.numbers.path, originals.numbers);
    for (const [index, pin] of input.lock.supplementalSources.entries()) await store('supplemental/' + pin.path, originals.supplemental[index]);
    for (const boundary of selection.boundaries) await store('boundaries/' + boundary.path, boundary.canonical);
    const commonSources = [await store(TARGET, originals.common), await store(HELPERS, originals.helpers)];
    const receipt = { schemaVersion: 1, kind: 'genuine-raw-fir-literal-light-node-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), original: input.lock.original, files: [input.lock.output, { ...input.lock.helpers, path: HELPERS }],
        host, parser, boundaries: selection.boundaries.map(project), references: selection.references, before: selection.checked[0],
        originalAlgorithmsRetained: true, omittedPsiAttachmentBranch: true, nodeProfile: 'sealed LightNode multiplatform parser',
        fullCompilerBuilt: false, psiAttachmentParity: false, classBinaryNameParity: false, universalJavaNumberStringParity: false };
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath)), commonSources, replacedOriginalPaths: [TARGET] };
}
async function replay({ outputRoot, expectedReceiptSha256 }) {
    outputRoot = path.resolve(outputRoot); const input = await inputs();
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    const bytes = await readRegular(path.join(outputRoot, 'receipt.json'));
    assert.equal(sha256(bytes), expectedReceiptSha256, 'External raw FIR preparation receipt changed');
    const receipt = JSON.parse(bytes);
    assert.equal(receipt.kind, 'genuine-raw-fir-literal-light-node-preparation'); assert.equal(receipt.sourceLockSha256, sha256(input.lockBytes));
    assert.deepEqual(receipt.source, input.lock.source); assert.deepEqual(receipt.original, input.lock.original);
    assert.deepEqual(receipt.files, [input.lock.output, { ...input.lock.helpers, path: HELPERS }]);
    assert.equal(receipt.fullCompilerBuilt, false); assert.equal(receipt.psiAttachmentParity, false);
    assert.equal(receipt.classBinaryNameParity, false); assert.equal(receipt.universalJavaNumberStringParity, false);
    assert.equal(receipt.originalAlgorithmsRetained, true); assert.equal(receipt.omittedPsiAttachmentBranch, true);
    assert.equal(receipt.nodeProfile, 'sealed LightNode multiplatform parser');
    const originals = await originalInputs(path.join(outputRoot, 'original'), path.join(outputRoot, 'supplemental'), input);
    for (const predecessor of [receipt.host, receipt.parser]) assert.equal(sha256(await readRegular(predecessor.receiptPath)), predecessor.receiptSha256, 'Raw FIR predecessor receipt changed');
    for (const pin of input.lock.boundaries) verifyFile(await readRegular(path.join(outputRoot, 'boundaries', pin.path)), pin);
    return { outputRoot, input, originals, receipt };
}
export async function verifyRawFirLiteralHost(options) {
    const { outputRoot, input } = await replay(options);
    verifyFile(await readRegular(path.join(outputRoot, TARGET)), input.lock.output);
    verifyFile(await readRegular(path.join(outputRoot, HELPERS)), input.lock.helpers);
    return true;
}
export async function verifyFinalRawFirLiteralHost({ retainedSources, recordedPropertyImports = [], ...options }) {
    const { outputRoot, input, originals, receipt } = await replay(options);
    const final = await selected(retainedSources, outputRoot, input, originals, recordedPropertyImports, true, receipt.boundaries);
    return { schemaVersion: 1, kind: 'genuine-raw-fir-literal-light-node-final', preparationReceiptSha256: options.expectedReceiptSha256,
        checked: final.checked, boundaries: final.boundaries.map(project), references: final.references,
        exactBodyAndOwnerVerified: true, psiAttachmentParity: false, classBinaryNameParity: false, universalJavaNumberStringParity: false, fullCompilerBuilt: false, languageReadiness: false };
}
