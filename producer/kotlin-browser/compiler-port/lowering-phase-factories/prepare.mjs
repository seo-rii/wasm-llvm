import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { normalizeTowerImports } from '../tower-group/transform.mjs';
import { TARGETS, HELPER, RECIPE, transformLoweringPhaseSource } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
function roots(sourceRoot, outputRoot) {
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep), 'Phase output must be under out/');
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Phase input/output overlap');
}
async function load(sourceRoot) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'genuine-lowering-phase-factory-metadata');
    assert.equal(lock.primaryClosureSha256, sha256(closureBytes)); assert.deepEqual(lock.source, closure.source);
    assert.deepEqual(lock.originals.map(pin => pin.path), TARGETS); assert.deepEqual(lock.recipes, RECIPE);
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    const originals = new Map(), common = new Map();
    for (const pin of [...lock.originals, ...lock.declarationFiles]) {
        assert.deepEqual(pin, closure.files.find(row => row.path === pin.path));
        const bytes = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin);
        originals.set(pin.path, bytes);
    }
    const callSites = JSON.parse(await readRegular(path.join(HERE, 'call-sites.json')));
    assert.deepEqual(callSites, lock.callSites);
    for (const row of callSites) {
        const caller = originals.get(row.caller); assert(caller);
        assert.equal(caller.subarray(row.byteStart, row.byteEnd).toString(), row.reference);
        assert.equal(row.rawClass, /^\w+/.exec(row.declaredReturnType)[0]);
        const expected = `loweringFactory(${row.rawClass}::class, ${row.reference})`;
        assert.equal(row.replacement, expected);
        if (row.localDeclaration) assert(caller.toString().includes(row.localDeclaration));
        for (const declaration of row.classDeclarations) {
            const bytes = originals.get(declaration.path); assert(bytes);
            assert.equal(bytes.toString().split('\n')[declaration.line - 1].trim(), declaration.declarationLine);
            const pkg = /^package ([^\r\n;]+)/m.exec(bytes.toString()); assert(pkg);
            assert.equal(declaration.qualifiedName, pkg[1] + '.' + row.rawClass);
        }
    }
    for (const pin of lock.outputs.filter(pin => pin.path !== HELPER)) {
        common.set(pin.path, verifyFile(transformLoweringPhaseSource(pin.path, originals.get(pin.path)), pin));
    }
    common.set(HELPER, verifyFile(await readRegular(path.join(HERE, 'LoweringPassFactory.kt')), lock.outputs.find(pin => pin.path === HELPER)));
    return { lock, lockBytes, originals, common };
}
function receiptFor(input) {
    return { schemaVersion: 1, kind: 'genuine-lowering-phase-factory-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), originals: input.lock.originals, declarationFiles: input.lock.declarationFiles,
        files: input.lock.outputs, recipes: RECIPE, callSites: input.lock.callSites,
        originalPhaseCreationAndExecutionBodiesRetained: true, introspectionInvokesFactories: false,
        explicitDeclaredReturnMetadata: true, classRepresentation: 'KClass', anonymousSimpleName: '',
        unregisteredFactoryFallback: 'explicit error', missingNativeDeclarations: input.lock.missingNativeDeclarations,
        completeNativeCallerCompiled: false, fullIrLoweringExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareLoweringPhaseFactories({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); roots(sourceRoot, outputRoot);
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const input = await load(sourceRoot), receipt = receiptFor(input), commonSources = [];
    for (const [logical, bytes] of input.originals) {
        const filename = path.join(outputRoot, 'reference-original', logical); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    }
    for (const [logical, bytes] of input.common) {
        const filename = path.join(outputRoot, relativePath(logical)); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); commonSources.push(filename);
    }
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath)), commonSources, replacedOriginalPaths: TARGETS };
}
async function replay({ sourceRoot, outputRoot, expectedReceiptSha256 }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); roots(sourceRoot, outputRoot);
    const input = await load(sourceRoot), receipt = receiptFor(input), bytes = await readRegular(path.join(outputRoot, 'receipt.json'), 64 * 1024 * 1024);
    assert.equal(sha256(bytes), expectedReceiptSha256, 'Phase receipt digest changed'); assert.deepEqual(JSON.parse(bytes), receipt, 'Phase receipt changed');
    for (const [logical, bytes] of input.originals) assert.deepEqual(await readRegular(path.join(outputRoot, 'reference-original', logical)), bytes, 'Phase full original snapshot changed');
    return { input, receipt, outputRoot };
}
export async function verifyLoweringPhaseFactories(options) {
    const replayed = await replay(options);
    for (const pin of replayed.receipt.files) verifyFile(await readRegular(path.join(replayed.outputRoot, pin.path)), pin);
    return replayed.receipt;
}
export async function verifyFinalLoweringPhaseFactories({ retainedSources, recordedPropertyImports = [], ...options }) {
    const { input, receipt, outputRoot } = await replay(options);
    assert(Array.isArray(retainedSources) && retainedSources.length, 'Phase actual final selection required');
    const paths = new Set(), filenames = new Set(), checked = [];
    for (const row of retainedSources) {
        relativePath(row.path); assert(!paths.has(row.path), 'Duplicate phase final logical path'); paths.add(row.path);
        assert(path.isAbsolute(row.filename) && !filenames.has(row.filename), 'Duplicate phase final owner'); filenames.add(row.filename);
        const pin = receipt.files.find(pin => pin.path === row.path); if (!pin) continue;
        assert.equal(row.filename, path.join(outputRoot, pin.path), 'Wrong phase final owner');
        const bytes = await readRegular(row.filename); assert.equal(bytes.length, row.bytes); assert.equal(sha256(bytes), row.sha256, 'Phase final source hash changed');
        verifyFile(normalizeTowerImports(bytes, input.common.get(pin.path), recordedPropertyImports), pin);
        checked.push({ path: row.path, filename: row.filename, bytes: row.bytes, sha256: row.sha256 });
    }
    assert.equal(checked.length, receipt.files.length, 'Missing phase final source');
    return { schemaVersion: 1, kind: 'genuine-lowering-phase-factory-final', sourceLockSha256: sha256(input.lockBytes),
        receiptSha256: options.expectedReceiptSha256, checked, exactBodyAndOwnerVerified: true,
        fullIrLoweringExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
}
