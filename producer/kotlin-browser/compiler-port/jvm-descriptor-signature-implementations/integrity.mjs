import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../../scripts/source.mjs';
import { prepareJvmDescriptorSignatureReferences, prepareJvmDescriptorSignatureImplementations, verifyJvmDescriptorSignatureImplementations,
    verifyFinalJvmDescriptorSignatureImplementations, OUTPUT_PREFIX } from './prepare.mjs';
import { jvmDescriptorSignatureFixture } from './fixture.mjs';
export async function jvmDescriptorSignatureIntegrity(outputRoot) {
    const args = await jvmDescriptorSignatureFixture(), reference = await prepareJvmDescriptorSignatureReferences({ outputRoot: path.join(outputRoot, 'reference-cache') });
    const prepared = await prepareJvmDescriptorSignatureImplementations({ ...args, sourceRoot: reference.sourceRoot, outputRoot: path.join(outputRoot, 'prepared') });
    const added = prepared.receipt.files.map(pin => ({ path: pin.path, filename: path.join(prepared.outputRoot, pin.path), bytes: pin.bytes, sha256: pin.sha256, compile: true }));
    const rows = [...args.retainedSources, ...added], options = { outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256,
        retainedSources: rows, recordedPropertyImports: args.recordedPropertyImports }, call = retainedSources => verifyFinalJvmDescriptorSignatureImplementations({ ...options, retainedSources });
    await verifyJvmDescriptorSignatureImplementations(options); const final = await call(rows);
    const lock = JSON.parse(await readFile(new URL('./sources.lock.json', import.meta.url))), receiptPathOnly = {};
    for (const spec of lock.bindings) receiptPathOnly[spec.name] = { receipt: args[spec.name].receipt,
        receiptPath: path.join(args[spec.name].outputRoot, spec.receiptFilename ?? 'receipt.json') };
    const pathOnly = await prepareJvmDescriptorSignatureImplementations({ ...args, ...receiptPathOnly, sourceRoot: reference.sourceRoot,
        outputRoot: path.join(outputRoot, 'receipt-path-only') });
    assert.deepEqual(pathOnly.receipt.bindings, prepared.receipt.bindings);
    await verifyJvmDescriptorSignatureImplementations({ outputRoot: pathOnly.outputRoot, expectedReceiptSha256: pathOnly.receiptSha256 });
    assert.equal(rows.length, 3571); assert.deepEqual(final.predecessorRetainedSources, args.retainedSources);
    for (const [index, row] of final.predecessorRetainedSources.entries()) { assert.equal(row, args.retainedSources[index]); assert.deepEqual(Object.keys(row), Object.keys(args.retainedSources[index])); }
    assert.deepEqual(prepared.replacedOriginalPaths, []); assert.deepEqual(prepared.sourceSetExclusions, []); assert.deepEqual(prepared.predecessorBindings, []);
    assert.equal(prepared.sourceFiles.length, 17); assert.deepEqual(prepared.sourceFiles.map(row => row.path), prepared.additionalOriginalPaths);
    const guards = [];
    async function reject(name, run, reason) {
        let error; try { await run(); } catch (caught) { error = caught; }
        assert(error, 'JVM signature guard accepted: ' + name); assert.match(String(error.message), reason, name);
        guards.push({ name, result: 'rejected', reason: String(error.message), expectedReason: reason.source, reasonMatched: true });
    }
    await reject('missing-complete-java-contract', () => call(rows.filter(row => row.path !== OUTPUT_PREFIX + 'JavaClassDescriptor.kt')), /Missing JVM signature output/);
    await reject('missing-closed-class-catalog', () => call(rows.filter(row => row.path !== OUTPUT_PREFIX + 'JvmForeignClassCatalog.kt')), /Missing JVM signature output/);
    await reject('missing-full-mapping-consumer', () => call(rows.filter(row => row.path !== OUTPUT_PREFIX + 'JavaToKotlinClassMap.kt')), /Missing JVM signature output/);
    await reject('inactive-output', () => call(rows.map(row => row.path === added[0].path ? { ...row, compile: false } : row)), /active rows/);
    await reject('duplicate-logical-owner', () => call([...rows, rows[0]]), /Duplicate JVM signature logical path/);
    await reject('caller-blessed-import', () => verifyFinalJvmDescriptorSignatureImplementations({ ...options, recordedPropertyImports: [...args.recordedPropertyImports, 'foreign.permission'] }), /final imports must match locked assembly/);
    const copy = path.join(outputRoot, 'same-body-other-owner.kt'); await copyFile(added[0].filename, copy);
    await reject('same-body-wrong-output-owner', () => call(rows.map(row => row.path === added[0].path ? { ...row, filename: copy } : row)), /Wrong JVM signature output owner/);
    for (const name of ['JvmForeignClassCatalog.kt', 'JavaToKotlinClassMap.kt', 'JavaClassDescriptor.kt']) {
        const row = added.find(row => row.path === OUTPUT_PREFIX + name), original = await readFile(row.filename), bad = Buffer.concat([original, Buffer.from('\n// forbidden body mutation\n')]);
        await writeFile(row.filename, bad);
        try { await reject('honest-digest-body-change-' + name, () => call(rows.map(candidate => candidate.path === row.path ? { ...candidate, bytes: bad.length, sha256: sha256(bad) } : candidate)), /output body\/imports changed/); }
        finally { await writeFile(row.filename, original); }
    }
    await reject('missing-real-class-parent', () => call(rows.filter(row => row.path !== 'compiler-port-descriptor-classes/ClassDescriptorImpl.kt')), /Missing JVM signature parent selection/);
    await reject('missing-real-name-parent', () => call(rows.filter(row => row.path !== 'compiler-port-core/Name.kt')), /Missing JVM signature parent selection/);
    await reject('missing-real-context-parent', () => call(rows.filter(row => !row.path.endsWith('/ClassicTypeSystemContext.kt'))), /Missing JVM signature selected dependency/);
    await reject('missing-required-assertion-host', () => call(rows.filter(row => row.path !== 'compiler-port-assertions/CompilerAssertions.kt')), /Missing JVM signature selected dependency/);
    await reject('wrong-external-receipt-digest', () => verifyJvmDescriptorSignatureImplementations({ ...options, expectedReceiptSha256: '0'.repeat(64) }), /Immutable JVM signature receipt pin required/);
    await reject('conflicting-supplied-parent-receipt-path', () => prepareJvmDescriptorSignatureImplementations({ ...args, sourceRoot: reference.sourceRoot,
        outputRoot: path.join(outputRoot, 'conflicting-receipt-path'), preparedFunctions: { ...args.preparedFunctions,
            receiptPath: path.join(args.preparedFunctions.outputRoot, 'foreign-receipt.json') } }), /Supplied JVM signature parent receipt path changed/);
    const stray = { ...added[0], path: OUTPUT_PREFIX + 'Foreign.kt', filename: copy };
    await reject('unrecorded-output', () => call([...rows, stray]), /Unrecorded JVM signature output/);
    const supplemental = prepared.sourceFiles[0], filename = path.join(prepared.originalSourceRoot, supplemental.path);
    await reject('active-supplemental-original', () => call([...rows, { path: supplemental.path, filename, bytes: supplemental.bytes, sha256: supplemental.sha256, compile: true }]), /Supplemental JVM original became an active/);
    const extraRows = rows.map(row => row === rows[0] ? { ...row, note: { preserve: true }, extra: 'complete metadata' } : row);
    const extra = await call(extraRows); assert.equal(extra.predecessorRetainedSources[0], extraRows[0]); assert.deepEqual(Object.keys(extra.predecessorRetainedSources[0]), Object.keys(extraRows[0]));
    const restored = await call(rows); assert.deepEqual(restored.predecessorRetainedSources, args.retainedSources);
    return { schemaVersion: 1, kind: 'genuine-jvm-descriptor-signature-source-integrity', result: 'pass', historical: args.historical,
        preparation: prepared.receipt, referenceCache: reference.receipt, final: final.receipt,
        actualSources: 3553, finalSources: 3571, restoredSources: 3553, outputs: 18, supplementalOriginals: 17, netAddedSources: 18,
        fullMetadataAndKeyOrderInverse: true, unaffectedRowsSameObjectsAndBytes: true, extraIncomingMetadataPreserved: true,
        allNineReceiptPathOnlyParentsVerified: true, conflictingSuppliedParentReceiptPathRejected: true,
        guards, guardCount: guards.length, restoredPositive: true, originalWholeCompilerExitCode: 1, newWholeCompilerExecuted: false,
        wasmExecuted: false, portableThreeProvidersPresent: false, fullCompilerBuilt: false, languageReadiness: false };
}
