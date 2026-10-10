import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { assertNoSymlink, json, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { bodyWithoutImports, HOST_ELEMENT_PATH, NAVIGATION_PATHS, SNAPSHOT_METHOD, TOKEN_SET_PATH, transformNavigation } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const limit = 128 * 1024 * 1024;
const pin = (relative, bytes) => ({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
const body = text => text.replace(/^(?:package|import)[^\r\n]+\r?\n/gm, '');
const verifyPrepared = (bytes, expected) => {
    assert.equal(bytes.length, expected.bytes); assert.equal(sha256(bytes), expected.sha256); return bytes;
};

async function recipe() {
    const bytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(bytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'official-fir-light-tree-navigation-port');
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    assert.deepEqual(lock.sources.slice(0, 4).map(item => item.path), NAVIGATION_PATHS);
    for (const [filename, expected] of Object.entries(lock.predecessorTools))
        assert.equal(sha256(await readRegular(path.join(here, filename))), expected, 'Selected host/positioning recipe changed: ' + filename);
    assert.equal(sha256(await readRegular(path.join(here, 'transform.mjs'))), lock.transformSha256);
    return { bytes, lock };
}

export function guardNavigationCallers(snapshot, lock, originals) {
    assert(Array.isArray(snapshot) && snapshot.length > 0 && snapshot.length <= 20000);
    const seen = new Set(), retained = [], traversal = [], tokenConsumers = [], tokenConstructors = [];
    const traversalPaths = new Set(lock.traversalConsumers), selectedPaths = new Set(NAVIGATION_PATHS);
    let total = 0;
    for (const item of snapshot) {
        relativePath(item.path); assert(item.path.endsWith('.kt')); assert(!seen.has(item.path)); seen.add(item.path);
        const bytes = Buffer.from(item.source, 'base64'); assert.equal(bytes.length, item.bytes); assert.equal(sha256(bytes), item.sha256);
        total += bytes.length; assert(total <= limit); const text = bytes.toString(), code = body(text);
        if (selectedPaths.has(item.path) || traversalPaths.has(item.path)) {
            const original = originals.get(item.path); assert(original, 'Pinned selected caller required');
            assert.equal(bodyWithoutImports(text), bodyWithoutImports(original.toString()), 'Selected navigation/caller algorithm changed: ' + item.path);
            retained.push({ path: item.path, bytes: item.bytes, sha256: item.sha256, originalBodySha256: sha256(Buffer.from(bodyWithoutImports(original.toString()))) });
        }
        if (/\b(?:PsiSourceNavigator|LightTreeSourceNavigator|FirPsiModifier(?:List)?)\b/.test(code))
            assert(selectedPaths.has(item.path), 'Unclosed removed PSI helper consumer: ' + item.path);
        if (/\bforEachChildOfType\b/.test(code)) {
            assert(item.path === NAVIGATION_PATHS[1] || traversalPaths.has(item.path), 'Unexpected traversal receiver consumer: ' + item.path);
            traversal.push(item.path);
        }
        if (/\bTokenSet\b/.test(text)) {
            assert(!/^import [^\r\n]*TokenSet\s+as\b/m.test(text) && !/\btypealias\b[^\n]*\bTokenSet\b/.test(code), 'TokenSet alias requires a new resolved caller review');
            const matches = [...code.matchAll(/\.(?:types|getTypes)\b|\bTokenSet\s*::\s*getTypes/g)];
            if (matches.length) {
                assert.equal(item.path, NAVIGATION_PATHS[1], 'Unsupported cached/ordered TokenSet array consumer: ' + item.path);
                assert.equal(matches.length, 1); assert.equal(code.split('types.types.toSet()').length, 2);
                tokenConsumers.push({ path: item.path, calls: 1, observedContract: 'copied set membership only' });
            }
            const constructors = [...code.matchAll(/\bTokenSet\.(create|orSet)\s*\(/g)].map(match => match[1]);
            if (constructors.length) tokenConstructors.push({ path: item.path, calls: constructors });
            assert(!new RegExp('\\b' + SNAPSHOT_METHOD + '\\b').test(code), 'Membership adapter already exists in selected graph');
        }
    }
    assert.deepEqual(retained.map(item => item.path).sort(), [...selectedPaths, ...traversalPaths].sort(), 'Missing retained navigation or typed traversal caller');
    assert.deepEqual(traversal.sort(), [NAVIGATION_PATHS[1], ...traversalPaths].sort());
    assert.equal(tokenConsumers.length, 1);
    return { inspectedKotlinFiles: snapshot.length, inspectedBytes: total, retained, traversal, tokenConsumers, tokenConstructors,
        limitation: 'Conservative lexical whole-selected-input guard; not a resolved FIR call graph. JVM array registration order and cached identity remain unsupported.' };
}

async function inputs(sourceRoot, preparedHost, preparedPositioning) {
    sourceRoot = path.resolve(sourceRoot); await assertNoSymlink(sourceRoot);
    const { bytes: lockBytes, lock } = await recipe(), originals = new Map();
    for (const entry of lock.sources) originals.set(entry.path, verifyFile(await readRegular(path.join(sourceRoot, entry.path)), entry));
    const hostReceiptBytes = await readRegular(preparedHost.receiptPath), hostReceipt = JSON.parse(hostReceiptBytes);
    assert.deepEqual(hostReceipt, preparedHost.receipt); assert.equal(hostReceipt.kind, 'official-compiler-portable-source-host-preparation');
    assert.equal(hostReceipt.source.commit, lock.source.commit); assert.equal(hostReceipt.sourceLockSha256, lock.predecessorTools['../host/sources.lock.json']);
    const hostPin = hostReceipt.sources.find(entry => entry.path === HOST_ELEMENT_PATH); assert(hostPin);
    assert.deepEqual({ path: hostPin.path, bytes: hostPin.bytes, sha256: hostPin.sha256 }, lock.hostElement);
    const hostMatches = preparedHost.commonSources.filter(filename => filename.endsWith('/' + HOST_ELEMENT_PATH)); assert.equal(hostMatches.length, 1);
    const hostElement = verifyPrepared(await readRegular(hostMatches[0]), lock.hostElement);
    const hostText = hostElement.toString();
    assert(hostText.includes('sealed class KtSourceElement : AbstractKtSourceElement()'));
    assert(!/\b(?:sealed |data )?class KtPsiSourceElement\b/.test(hostText));
    assert.equal([...hostText.matchAll(/: KtSourceElement\(/g)].length, 1, 'Selected sealed source family changed');
    assert(hostText.includes('class KtLightSourceElement('));
    const positioningBytes = await readRegular(preparedPositioning.receiptPath), positioning = JSON.parse(positioningBytes);
    assert.deepEqual(positioning, preparedPositioning.receipt); assert.equal(positioning.kind, 'official-compiler-light-tree-positioning-source-preparation');
    assert.equal(positioning.source.commit, lock.source.commit); assert.equal(positioning.recipeSha256, lock.predecessorTools['../positioning/positioning.recipe.json']);
    assert.equal(positioning.prepareScriptSha256, lock.predecessorTools['../positioning/prepare.mjs']);
    const tokenDeclared = positioning.outputs.find(entry => entry.path === 'TokenSet.kt'); assert.deepEqual(tokenDeclared, lock.tokenSet);
    const matches = preparedPositioning.commonSources.filter(filename => filename.endsWith('/' + TOKEN_SET_PATH)); assert.equal(matches.length, 1);
    const filename = path.resolve(matches[0]); assert(filename.startsWith(path.join(repository, 'out') + path.sep));
    const tokenSet = verifyPrepared(await readRegular(filename), lock.tokenSet);
    const lightDeclared = positioning.outputs.find(entry => entry.path === 'LightTreeUtils.kt'); assert.deepEqual(lightDeclared, lock.lightTreeUtils);
    const lightFiles = preparedPositioning.commonSources.filter(file => file.endsWith('/compiler-port-positioning/LightTreeUtils.kt')); assert.equal(lightFiles.length, 1);
    const lightTreeUtils = verifyPrepared(await readRegular(lightFiles[0]), lock.lightTreeUtils);
    const binding = { component: 'positioningReceipt', logicalPath: TOKEN_SET_PATH, componentRelativePath: TOKEN_SET_PATH, filename,
        bytes: tokenSet.length, sha256: sha256(tokenSet), receiptSha256: sha256(positioningBytes),
        sourceLockSha256: positioning.recipeSha256, preparationToolSha256: positioning.prepareScriptSha256 };
    return { lockBytes, lock, originals, hostReceiptBytes, hostElement, positioningBytes, tokenSet, lightTreeUtils, binding };
}

function receiptFor(input, transformed, snapshot, snapshotPin, referencePins, prepareSha256) {
    const outputs = transformed.outputs.map(item => pin(item.path, item.bytes)); assert.deepEqual(outputs, input.lock.outputs);
    assert.deepEqual(transformed.changes, input.lock.changes);
    return { schemaVersion: 1, kind: 'official-fir-light-tree-navigation-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: prepareSha256, transformSha256: input.lock.transformSha256,
        originalInputs: input.lock.sources, referencePins, files: outputs, changes: transformed.changes,
        replacedOriginalPaths: NAVIGATION_PATHS, predecessorBindings: [input.binding],
        reusedLightTreeUtils: { component: 'positioningReceipt', ...input.lock.lightTreeUtils }, snapshot: snapshotPin,
        callerGuard: guardNavigationCallers(snapshot, input.lock, input.originals), retainedFullChecker: NAVIGATION_PATHS[3],
        sourceProfile: 'Existing pinned sealed LightTree-only KtSourceElement family; PSI branch/declaration split only',
        tokenSetContract: 'Copied membership from exact existing storage, not general getTypes/cached-array parity',
        fullFirCheckerExecution: 'not-run', kmpSyntaxToLegacyTokenMapping: 'absent', fullCompilerBuilt: false, publicLanguageSupport: false };
}

export async function prepareFirNavigationSources({ sourceRoot, outputRoot, retainedSources, preparedHost, preparedPositioning }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    for (const filename of [...preparedHost.commonSources, ...preparedPositioning.commonSources])
        assert(!path.resolve(filename).startsWith(outputRoot + path.sep), 'Prepared source input/output overlap');
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep));
    const input = await inputs(sourceRoot, preparedHost, preparedPositioning);
    assert(Array.isArray(retainedSources) && retainedSources.length > 0 && retainedSources.length <= 20000);
    const snapshot = []; let total = 0;
    for (const item of retainedSources) {
        const bytes = await readRegular(item.filename); assert.equal(bytes.length, item.bytes); assert.equal(sha256(bytes), item.sha256);
        total += bytes.length; assert(total <= limit); snapshot.push({ path: item.path, bytes: bytes.length, sha256: sha256(bytes), source: bytes.toString('base64') });
    }
    guardNavigationCallers(snapshot, input.lock, input.originals);
    const transformed = transformNavigation(input.originals, input.tokenSet), referencePins = [];
    await assertNoSymlink(outputRoot); await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    async function publish(relative, bytes) {
        const filename = path.join(outputRoot, relativePath(relative)); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        referencePins.push(pin(relative, bytes)); return filename;
    }
    for (const [relative, bytes] of input.originals) await publish('reference/' + relative, bytes);
    for (const [relative, bytes] of [['host/' + HOST_ELEMENT_PATH, input.hostElement], ['host/host-receipt.json', input.hostReceiptBytes],
        ['predecessor/' + TOKEN_SET_PATH, input.tokenSet], ['predecessor/compiler-port-positioning/LightTreeUtils.kt', input.lightTreeUtils],
        ['predecessor/positioning-inputs.json', input.positioningBytes], ['predecessor/binding.json', Buffer.from(json(input.binding))]]) await publish(relative, bytes);
    const snapshotBytes = gzipSync(Buffer.from(JSON.stringify(snapshot))), snapshotPin = pin('retained-source-snapshot.json.gz', snapshotBytes);
    await publish(snapshotPin.path, snapshotBytes); const references = referencePins.slice(), commonSources = [];
    for (const item of transformed.outputs) commonSources.push(await publish(item.path, item.bytes));
    const receipt = receiptFor(input, transformed, snapshot, snapshotPin, references, sha256(await readRegular(fileURLToPath(import.meta.url))));
    const receiptPath = path.join(outputRoot, 'fir-navigation-inputs.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, commonSources, replacedOriginalPaths: NAVIGATION_PATHS, predecessorBindings: [input.binding], receipt, receiptPath };
}

// Reconstruct the canonical preparation from immutable references. Assembly
// rewrites imports in the output files, so this replay never reads those files.
async function replayPreparation(root) {
    root = path.resolve(root); assert(root.startsWith(path.join(repository, 'out') + path.sep)); await assertNoSymlink(root);
    const receiptBytes = await readRegular(path.join(root, 'fir-navigation-inputs.json')), receipt = JSON.parse(receiptBytes);
    const input = await inputs(path.join(root, 'reference'), {
        receiptPath: path.join(root, 'host/host-receipt.json'), receipt: JSON.parse(await readRegular(path.join(root, 'host/host-receipt.json'))),
        commonSources: [path.join(root, 'host', HOST_ELEMENT_PATH)],
    }, { receiptPath: path.join(root, 'predecessor/positioning-inputs.json'), receipt: JSON.parse(await readRegular(path.join(root, 'predecessor/positioning-inputs.json'))),
        commonSources: [path.join(root, 'predecessor', TOKEN_SET_PATH), path.join(root, 'predecessor/compiler-port-positioning/LightTreeUtils.kt')] });
    const bindingBytes = await readRegular(path.join(root, 'predecessor/binding.json')), binding = JSON.parse(bindingBytes);
    assert(path.isAbsolute(binding.filename) && binding.filename.startsWith(path.join(repository, 'out') + path.sep) && binding.filename.endsWith('/' + TOKEN_SET_PATH));
    input.binding.filename = binding.filename; assert.deepEqual(binding, input.binding); assert.deepEqual(bindingBytes, Buffer.from(json(binding)));
    const expected = [...input.originals].map(([relative, bytes]) => pin('reference/' + relative, bytes));
    expected.push(pin('host/' + HOST_ELEMENT_PATH, input.hostElement), pin('host/host-receipt.json', input.hostReceiptBytes), pin('predecessor/' + TOKEN_SET_PATH, input.tokenSet),
        pin('predecessor/compiler-port-positioning/LightTreeUtils.kt', input.lightTreeUtils), pin('predecessor/positioning-inputs.json', input.positioningBytes), pin('predecessor/binding.json', bindingBytes));
    assert.equal(receipt.snapshot.path, 'retained-source-snapshot.json.gz'); const snapshotBytes = await readRegular(path.join(root, receipt.snapshot.path), limit);
    verifyPrepared(snapshotBytes, receipt.snapshot); expected.push(pin(receipt.snapshot.path, snapshotBytes)); assert.deepEqual(receipt.referencePins, expected);
    const snapshot = JSON.parse(gunzipSync(snapshotBytes, { maxOutputLength: limit * 2 })), transformed = transformNavigation(input.originals, input.tokenSet);
    assert.deepEqual(receipt, receiptFor(input, transformed, snapshot, receipt.snapshot, expected, sha256(await readRegular(fileURLToPath(import.meta.url)))));
    return { receipt, receiptSha256: sha256(receiptBytes), input, transformed };
}

export async function verifyFirNavigation(root) {
    root = path.resolve(root);
    const { receipt, receiptSha256, transformed } = await replayPreparation(root);
    for (const item of transformed.outputs) assert.deepEqual(await readRegular(path.join(root, item.path)), item.bytes);
    return { receipt, receiptSha256 };
}

// Preparation binds canonical predecessor bytes before import assembly. This
// second guard observes the actual final graph, including late components and
// entry points, rather than claiming the early snapshot covers those inputs.
export async function verifyFirNavigationFinalSources({ profileRoot, retainedSources, allowedAddedImports = [] }) {
    profileRoot = path.resolve(profileRoot);
    const prepared = await replayPreparation(profileRoot), { lock, originals } = prepared.input;
    assert(Array.isArray(retainedSources) && retainedSources.length > 0 && retainedSources.length <= 20000);
    assert(Array.isArray(allowedAddedImports) && new Set(allowedAddedImports).size === allowedAddedImports.length);
    for (const name of allowedAddedImports) assert(typeof name === 'string' && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\.\*)?$/.test(name), 'Invalid known added import');
    const allowed = new Set(allowedAddedImports), expected = new Map(), shadows = new Map();
    for (const entry of prepared.transformed.outputs) expected.set(entry.path, entry.bytes);
    for (const relative of NAVIGATION_PATHS) shadows.set(relative, originals.get(relative));
    shadows.set(TOKEN_SET_PATH, verifyPrepared(await readRegular(path.join(profileRoot, 'predecessor', TOKEN_SET_PATH)), lock.tokenSet));
    const importNames = text => [...text.matchAll(/^import ([^\r\n]+)\r?\n/gm)].map(match => match[1]);
    const finalSnapshot = [], shadowSnapshot = [], bindings = [], seen = new Set(); let total = 0;
    for (const item of retainedSources) {
        relativePath(item.path); assert(item.path.endsWith('.kt') && !seen.has(item.path)); seen.add(item.path);
        assert(path.resolve(item.filename).startsWith(path.join(repository, 'out') + path.sep));
        const bytes = await readRegular(item.filename); verifyPrepared(bytes, item); total += bytes.length; assert(total <= limit);
        const actual = { path: item.path, bytes: bytes.length, sha256: sha256(bytes), source: bytes.toString('base64') }; finalSnapshot.push(actual);
        if (!expected.has(item.path)) { shadowSnapshot.push(actual); continue; }
        assert.equal(path.resolve(item.filename), path.join(profileRoot, item.path), 'Final navigation source filename changed: ' + item.path);
        const canonical = expected.get(item.path), actualText = bytes.toString(), canonicalText = canonical.toString();
        assert.equal(bodyWithoutImports(actualText), bodyWithoutImports(canonicalText), 'Final navigation output body changed: ' + item.path);
        const priorImports = importNames(canonicalText), finalImports = importNames(actualText);
        assert.equal(new Set(finalImports).size, finalImports.length, 'Duplicate final navigation import');
        for (const name of priorImports) assert(finalImports.includes(name), 'Canonical host import was removed/replaced: ' + name);
        const addedImports = finalImports.filter(name => !priorImports.includes(name));
        for (const name of addedImports) assert(allowed.has(name), 'Unverified host import in final navigation output: ' + name);
        bindings.push({ path: item.path, filename: path.resolve(item.filename), bytes: bytes.length, sha256: sha256(bytes),
            canonicalBytes: canonical.length, canonicalSha256: sha256(canonical), bodySha256: sha256(Buffer.from(bodyWithoutImports(canonicalText))), addedImports });
        const shadow = shadows.get(item.path); shadowSnapshot.push({ path: item.path, bytes: shadow.length, sha256: sha256(shadow), source: shadow.toString('base64') });
    }
    assert.deepEqual(bindings.map(item => item.path).sort(), [...expected.keys()].sort(), 'Missing one of the five final navigation outputs');
    const callerGuard = guardNavigationCallers(shadowSnapshot, lock, originals);
    const root = path.join(profileRoot, 'final'); await assertNoSymlink(root); await mkdir(root, { mode: 0o700 });
    const snapshotBytes = gzipSync(Buffer.from(JSON.stringify(finalSnapshot))), snapshotPin = pin('retained-source-snapshot.json.gz', snapshotBytes);
    await writeFile(path.join(root, snapshotPin.path), snapshotBytes, { flag: 'wx', mode: 0o600 });
    const receipt = { schemaVersion: 1, kind: 'official-fir-navigation-final-assembly-guard', source: lock.source,
        preparedReceiptSha256: prepared.receiptSha256, sourceLockSha256: prepared.receipt.sourceLockSha256,
        finalGuardToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), snapshot: snapshotPin,
        inspectedKotlinFiles: finalSnapshot.length, inspectedBytes: total, allowedAddedImports, bindings, callerGuard,
        shadowedPaths: [...shadows.keys()], shadowContract: 'Only five verified final replacements use immutable originals/predecessor for caller scan; stored snapshot contains actual final bytes',
        fullFirCheckerExecution: 'not-run', fullCompilerBuilt: false, publicLanguageSupport: false };
    const receiptPath = path.join(root, 'fir-navigation-final.json'); await writeJson(receiptPath, receipt);
    return { receipt, receiptPath };
}
