import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { assembleImports } from '../type-substitutor-getter/prepare.mjs';
import { normalizeImports } from '../descriptor-base-implementations/prepare.mjs';
import { OUTPUT_PREFIX, EXPECTED_SOURCE, verifyCompleteSources } from './transform.mjs';
export { OUTPUT_PREFIX } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
function checkRoot(root) { assert(path.isAbsolute(root) && root.startsWith(path.join(REPO, 'out') + path.sep), 'JVM signature output must be under out/'); }
function assembledEquals(actual, canonical, imports) { return actual.equals(assembleImports(canonical, imports)) || normalizeImports(actual, imports).equals(normalizeImports(canonical, [])); }
async function load(sourceRoot = path.join(HERE, 'originals')) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const primaryBytes = await readRegular(path.join(HERE, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
    assert.equal(lock.kind, 'genuine-jvm-descriptor-signature-implementations'); assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.primaryClosureSha256, sha256(primaryBytes)); assert.deepEqual(lock.source, primary.source);
    assert.deepEqual(lock.sourceIdentity, EXPECTED_SOURCE); assert.equal(lock.source.treeSha, EXPECTED_SOURCE.rootTreeSha);
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    const facts = JSON.parse(verifyFile(await readRegular(path.join(HERE, 'source-facts.json')), lock.sourceFacts));
    assert.deepEqual(lock.originals, facts.originals); assert.deepEqual(lock.common, facts.outputs);
    const originals = new Map(), common = new Map();
    for (const pin of lock.originals) {
        assert(!primary.files.some(row => row.path === pin.path), 'Supplemental JVM original conflicts with primary closure');
        relativePath(pin.path); originals.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin));
    }
    for (const pin of lock.common) common.set(pin.path, verifyFile(await readRegular(path.join(HERE, 'common', pin.path)), pin));
    const provenance = {};
    for (const [name, filename] of [['commit', 'upstream-commit.json'], ['root', 'upstream-root-tree.json'], ['core', 'upstream-core-tree.json'],
        ['coverage', 'metadata-source-coverage.json'], ['records', 'foreign-class-metadata.json']]) provenance[name] = JSON.parse(await readRegular(path.join(HERE, 'provenance', filename)));
    verifyCompleteSources(facts, originals, common, provenance);
    for (const spec of lock.bindings) for (const pin of spec.files) verifyFile(await readRegular(path.join(HERE, pin.localPath)), pin);
    for (const pin of lock.selectionDependencies) verifyFile(await readRegular(path.join(HERE, pin.localPath)), pin);
    assert.equal(new Set(lock.assemblyImports).size, lock.assemblyImports.length);
    return { lock, lockBytes, facts, originals, common };
}
async function inventory(rows) {
    assert(Array.isArray(rows) && rows.length, 'Actual JVM signature selection required'); const paths = new Set(), owners = new Set(), result = [];
    for (const row of rows) {
        relativePath(row.path); assert.equal(row.compile, true, 'JVM signature selection must contain active rows');
        assert(!paths.has(row.path), 'Duplicate JVM signature logical path'); paths.add(row.path);
        assert(path.isAbsolute(row.filename) && !owners.has(row.filename), 'Duplicate JVM signature owner'); owners.add(row.filename);
        const body = await readRegular(row.filename); assert.equal(body.length, row.bytes, 'JVM signature selected bytes changed');
        assert.equal(sha256(body), row.sha256, 'JVM signature selected SHA changed'); result.push({ path: row.path, filename: row.filename, bytes: row.bytes, sha256: row.sha256 });
    }
    return result;
}
async function relevant(input, receipt, rows, imports) {
    assert.equal(receipt.bindings.length, input.lock.bindings.length);
    for (const [index, bound] of receipt.bindings.entries()) {
        const spec = input.lock.bindings[index]; assert.equal(bound.name, spec.name); checkRoot(bound.outputRoot);
        assert.equal(bound.receiptPath, path.join(bound.outputRoot, spec.receiptFilename ?? 'receipt.json'));
        const bytes = await readRegular(bound.receiptPath), parent = JSON.parse(bytes);
        assert.equal(sha256(bytes), bound.receiptSha256, 'JVM signature parent receipt changed'); assert.equal(parent.kind, spec.kind);
        assert.deepEqual(parent.source, input.lock.source); assert.equal(parent[spec.lockField ?? 'sourceLockSha256'], spec.sourceLockSha256);
        for (const pin of spec.files) {
            const reported = spec.name === 'preparedCore' ? parent.portable : parent.files.find(row => row.path === pin.receiptPath);
            assert(reported, 'Missing JVM signature parent artifact'); assert.equal(reported.bytes, pin.bytes); assert.equal(reported.sha256, pin.sha256);
            const filename = path.join(bound.outputRoot, pin.outputPath), selected = rows.find(row => row.path === pin.path);
            assert(selected, 'Missing JVM signature parent selection'); assert.equal(selected.filename, filename, 'Wrong JVM signature parent owner');
            assert(assembledEquals(await readRegular(filename), await readRegular(path.join(HERE, pin.localPath)), imports), 'JVM signature parent body/imports changed');
        }
    }
    assert.deepEqual(receipt.selectionOwners.map(row => row.path), input.lock.selectionDependencies.map(row => row.path));
    for (const [index, owner] of receipt.selectionOwners.entries()) {
        const row = rows.find(row => row.path === owner.path); assert(row, 'Missing JVM signature selected dependency');
        assert.equal(row.filename, owner.filename, 'Wrong JVM signature selected dependency owner');
        assert(assembledEquals(await readRegular(row.filename), await readRegular(path.join(HERE, input.lock.selectionDependencies[index].localPath)), imports), 'JVM signature selected dependency body/imports changed');
    }
    assert(!rows.some(row => input.lock.originals.some(pin => pin.path === row.path)), 'Supplemental JVM original became an active compiler input');
}
function receiptFor(input, bindings, selectionOwners, selectedInventory, recordedPropertyImports) {
    return { schemaVersion: 1, kind: 'genuine-jvm-descriptor-signature-preparation', source: input.lock.source,
        sourceIdentity: input.lock.sourceIdentity, sourceLockSha256: sha256(input.lockBytes), files: input.lock.common.map(pin => ({ ...pin, path: OUTPUT_PREFIX + pin.path })),
        sourceFiles: input.lock.originals, additionalOriginalPaths: input.lock.originals.map(row => row.path), replacedOriginalPaths: [], sourceSetExclusions: [], predecessorBindings: [],
        bindings, selectionOwners, selectedInventory, recordedPropertyImports, expectedFinalPropertyImports: input.lock.assemblyImports,
        fullKotlinRecipes: 11, completeJavaHelpers: 3, completeJavaClassDescriptorContract: true, exactEnhancedNullabilityDeclarations: 2,
        foreignClassCatalog: { records: 33, directTargets: 18, privateReifiedSpecializations: 8, annotationTargets: 7,
            dynamicClassInputsSupported: false, metadataLookupAfterMutableClassIdConstruction: true, recordsAreMeasuredJdkFacts: true },
        originalSourcesUnmodified: true, primaryClosureChanged: false, existingSourceExcluded: false, compilerEntryChanged: false, hostInstalled: false,
        javaReflectiveFieldLayoutParity: false, extraCommonJvmCompanionField: true, enumMapImplementationIdentityParity: false,
        bootstrapSourceCommit: null, portableThreeProvidersPresent: false, wasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
}
/** Verified tracked upstream bytes form a separate supplemental cache; the primary sourceRoot is never written. */
export async function prepareJvmDescriptorSignatureReferences({ outputRoot = path.join(REPO, 'out/kotlin-jvm-descriptor-signature-reference') } = {}) {
    outputRoot = path.resolve(outputRoot); checkRoot(outputRoot); await assertNoSymlink(outputRoot); const input = await load(), sourceRoot = path.join(outputRoot, 'sources');
    for (const pin of input.lock.originals) {
        const filename = path.join(sourceRoot, pin.path); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        try { await writeFile(filename, input.originals.get(pin.path), { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        verifyFile(await readRegular(filename), pin);
    }
    const receipt = { schemaVersion: 1, kind: 'genuine-jvm-signature-supplemental-original-cache', source: input.lock.source, sourceIdentity: input.lock.sourceIdentity,
        sourceLockSha256: sha256(input.lockBytes), files: input.lock.originals, originalTrackedBytesVerified: true, newUpstreamFetchExecuted: false, primarySourceRootMutated: false };
    const receiptPath = path.join(outputRoot, 'source-references.json');
    try { await writeJson(receiptPath, receipt); } catch (error) { if (error.code !== 'EEXIST') throw error; assert.deepEqual(JSON.parse(await readRegular(receiptPath)), receipt); }
    return { sourceRoot, receiptPath, receipt };
}
export async function prepareJvmDescriptorSignatureImplementations(args) {
    const sourceRoot = path.resolve(args.sourceRoot), outputRoot = path.resolve(args.outputRoot), imports = args.recordedPropertyImports ?? []; checkRoot(outputRoot);
    for (const root of [sourceRoot, outputRoot]) await assertNoSymlink(root);
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'JVM signature roots overlap');
    const input = await load(sourceRoot), rows = await inventory(args.retainedSources), bindings = [];
    assert(!rows.some(row => row.path.startsWith(OUTPUT_PREFIX)), 'JVM signature outputs already selected');
    assert(imports.length === 0 || JSON.stringify(imports) === JSON.stringify(input.lock.assemblyImports), 'JVM signature preparation imports must match locked assembly');
    for (const spec of input.lock.bindings) {
        const supplied = args[spec.name]; assert(supplied?.receipt && (supplied.outputRoot || supplied.receiptPath), 'Missing ' + spec.name);
        const receiptFilename = spec.receiptFilename ?? 'receipt.json';
        const inferredRoot = supplied.receiptPath && path.resolve(supplied.receiptPath, ...receiptFilename.split('/').map(() => '..'));
        const root = path.resolve(supplied.outputRoot ?? inferredRoot); checkRoot(root);
        const receiptPath = path.join(root, receiptFilename);
        if (supplied.receiptPath) assert.equal(path.resolve(supplied.receiptPath), receiptPath, 'Supplied JVM signature parent receipt path changed');
        const bytes = await readRegular(receiptPath);
        assert.deepEqual(JSON.parse(bytes), supplied.receipt, 'Supplied JVM signature parent receipt changed'); bindings.push({ name: spec.name, outputRoot: root, receiptPath, receiptSha256: sha256(bytes) });
    }
    const owners = input.lock.selectionDependencies.map(pin => { const row = rows.find(row => row.path === pin.path); assert(row, 'Missing JVM signature selected dependency'); return { path: pin.path, filename: row.filename }; });
    const receipt = receiptFor(input, bindings, owners, rows, imports); await relevant(input, receipt, rows, imports);
    for (const pin of input.lock.originals) {
        const filename = path.join(outputRoot, 'reference', pin.path); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, input.originals.get(pin.path), { flag: 'wx', mode: 0o600 });
    }
    const commonSources = [];
    for (const pin of receipt.files) {
        const filename = path.join(outputRoot, pin.path); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, input.common.get(pin.path.slice(OUTPUT_PREFIX.length)), { flag: 'wx', mode: 0o600 }); commonSources.push(filename);
    }
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, receiptSha256: sha256(await readRegular(receiptPath)), commonSources,
        sourceFiles: receipt.sourceFiles, additionalOriginalPaths: receipt.additionalOriginalPaths, originalSourceRoot: path.join(outputRoot, 'reference'),
        replacedOriginalPaths: [], sourceSetExclusions: [], predecessorBindings: [] };
}
async function replay(outputRoot, expectedReceiptSha256) {
    outputRoot = path.resolve(outputRoot); checkRoot(outputRoot); await assertNoSymlink(outputRoot); const input = await load(path.join(outputRoot, 'reference'));
    const bytes = await readRegular(path.join(outputRoot, 'receipt.json'), 64 * 1024 * 1024), receipt = JSON.parse(bytes);
    assert.equal(sha256(bytes), expectedReceiptSha256, 'Immutable JVM signature receipt pin required');
    assert.deepEqual(receipt, receiptFor(input, receipt.bindings, receipt.selectionOwners, receipt.selectedInventory, receipt.recordedPropertyImports));
    return { input, receipt, outputRoot };
}
export async function verifyJvmDescriptorSignatureImplementations(options) {
    const { input, receipt, outputRoot } = await replay(options.outputRoot, options.expectedReceiptSha256);
    const rows = await inventory(receipt.selectedInventory.map(row => ({ ...row, compile: true }))); await relevant(input, receipt, rows, receipt.recordedPropertyImports);
    for (const pin of receipt.files) verifyFile(await readRegular(path.join(outputRoot, pin.path)), pin); return receipt;
}
export async function verifyFinalJvmDescriptorSignatureImplementations({ outputRoot, expectedReceiptSha256, retainedSources, recordedPropertyImports = [] }) {
    const { input, receipt, outputRoot: root } = await replay(outputRoot, expectedReceiptSha256), rows = await inventory(retainedSources);
    assert.deepEqual(recordedPropertyImports, input.lock.assemblyImports, 'JVM signature final imports must match locked assembly'); await relevant(input, receipt, rows, recordedPropertyImports);
    const checked = [];
    for (const pin of receipt.files) {
        const row = rows.find(row => row.path === pin.path); assert(row, 'Missing JVM signature output'); assert.equal(row.filename, path.join(root, pin.path), 'Wrong JVM signature output owner');
        assert(assembledEquals(await readRegular(row.filename), input.common.get(pin.path.slice(OUTPUT_PREFIX.length)), recordedPropertyImports), 'JVM signature output body/imports changed'); checked.push(row);
    }
    assert.equal(rows.filter(row => row.path.startsWith(OUTPUT_PREFIX)).length, 18, 'Unrecorded JVM signature output');
    const predecessorRetainedSources = retainedSources.filter(row => !row.path.startsWith(OUTPUT_PREFIX));
    assert.equal(predecessorRetainedSources.length, retainedSources.length - 18);
    return { receipt: { schemaVersion: 1, kind: 'genuine-jvm-descriptor-signature-final', sourceLockSha256: sha256(input.lockBytes), sourceIdentity: input.lock.sourceIdentity,
        checked, selectedSources: rows.length, removedFromPredecessorView: receipt.files.map(row => row.path), restoredContractPredecessors: [],
        unaffectedOwnerBodyAndCompleteMetadataOrderPreserved: true, portableThreeProvidersPresent: false, wasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false }, predecessorRetainedSources };
}
