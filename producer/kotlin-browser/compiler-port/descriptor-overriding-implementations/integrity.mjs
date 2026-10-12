import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { prepareDescriptorOverridingImplementations, verifyDescriptorOverridingImplementations, verifyFinalDescriptorOverridingImplementations, OUTPUT_PREFIX } from './prepare.mjs';
import { OVERLAYS } from './transform.mjs';
import { overridingImplementationFixture } from './fixture.mjs';
export async function runOverridingIntegrity(outputRoot) {
    const args = await overridingImplementationFixture(), prepared = await prepareDescriptorOverridingImplementations({ ...args, outputRoot: path.join(outputRoot, 'prepared') });
    const selection = args.retainedSources.map(row => { const replacement = prepared.receipt.files.find(pin => pin.path === row.path);
        return replacement ? { ...row, filename: path.join(prepared.outputRoot, row.path), bytes: replacement.bytes, sha256: replacement.sha256 } : row; });
    for (const pin of prepared.receipt.files.filter(pin => pin.path.startsWith(OUTPUT_PREFIX))) selection.push({ path: pin.path, filename: path.join(prepared.outputRoot, pin.path), bytes: pin.bytes, sha256: pin.sha256, compile: true });
    assert.equal(selection.length, 3552);
    const options = { outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256, retainedSources: selection, recordedPropertyImports: args.recordedPropertyImports };
    const verified = await verifyDescriptorOverridingImplementations(options), final = await verifyFinalDescriptorOverridingImplementations(options);
    assert.equal(verified.files.length, 7); assert.equal(final.predecessorRetainedSources.length, 3549);
    assert.deepEqual(final.predecessorRetainedSources, args.retainedSources, 'Exact actual metadata/order preimage required');
    for (const [i, row] of final.predecessorRetainedSources.entries()) { assert.deepEqual(Object.keys(row), Object.keys(args.retainedSources[i]), 'Full row key order changed');
        if (!OVERLAYS.some(spec => spec[0] === row.path)) assert.equal(row, args.retainedSources[i], 'Unaffected row identity changed'); }
    const guards = [];
    async function rejected(name, invoke, expected) { let error; try { await invoke(); } catch (e) { error = e; }
        assert(error, 'Overriding guard accepted: ' + name); assert.match(String(error.message), expected, 'Wrong rejecting reason: ' + name); guards.push({ name, result: 'rejected', reason: String(error.message) }); }
    const run = rows => verifyFinalDescriptorOverridingImplementations({ ...options, retainedSources: rows });
    await rejected('missing-complete-provider', () => run(selection.filter(row => row.path !== OUTPUT_PREFIX + 'OverridingUtil.kt')), /Missing overriding output/);
    await rejected('missing-required-host', () => run(selection.filter(row => row.path !== OUTPUT_PREFIX + 'OverridingHost.kt')), /Missing overriding output/);
    await rejected('inactive-provider-row', () => run(selection.map(row => row.path === OUTPUT_PREFIX + 'OverridingUtil.kt' ? { ...row, compile: false } : row)), /active compile rows/);
    await rejected('caller-blessed-foreign-import-list', () => verifyFinalDescriptorOverridingImplementations({ ...options, recordedPropertyImports: [...args.recordedPropertyImports, 'foreign.policy.blessed'] }), /Overriding final imports must match locked assembly/);
    await rejected('duplicate-logical-row', () => run([...selection, selection[0]]), /Duplicate overriding logical path/);
    const originalJavaFile = path.join(prepared.outputRoot, 'reference/core/descriptors/src/org/jetbrains/kotlin/resolve/OverridingUtil.java'), originalJavaBytes = await readRegular(originalJavaFile);
    await rejected('original-java-reintroduced', () => run([...selection, { path: 'core/descriptors/src/org/jetbrains/kotlin/resolve/OverridingUtil.java', filename: originalJavaFile, bytes: originalJavaBytes.length, sha256: sha256(originalJavaBytes), compile: true }]), /Original Java overriding source reintroduced/);
    await rejected('unrecorded-new-output', async () => { const f = path.join(outputRoot, 'Unexpected.kt'); await writeFile(f, 'package extra\n'); const b = await readFile(f); return run([...selection, { path: OUTPUT_PREFIX + 'Unexpected.kt', filename: f, bytes: b.length, sha256: sha256(b), compile: true }]); }, /Unrecorded overriding output/);
    // Extra incoming metadata is preserved; a changed recorded field must be rejected.
    const metadataSelection = selection.map(row => row.path === OVERLAYS[0][0] ? { ...row, note: { nested: true } } : row);
    const metadataFinal = await run(metadataSelection); assert.deepEqual(metadataFinal.predecessorRetainedSources.find(row => row.path === OVERLAYS[0][0]).note, { nested: true });
    for (const logical of [OUTPUT_PREFIX + 'OverridingUtil.kt', ...OVERLAYS.map(row => row[0])]) {
        const row = selection.find(row => row.path === logical), alternate = path.join(outputRoot, 'owner-' + guards.length + '.kt'); await copyFile(row.filename, alternate);
        await rejected('identical-body-owner-swap-' + path.basename(logical), () => run(selection.map(item => item.path === logical ? { ...item, filename: alternate } : item)), /Wrong overriding output owner/);
        const saved = await readFile(row.filename), bad = Buffer.concat([saved, Buffer.from('\n// unauthorized body change\n')]);
        await writeFile(row.filename, bad);
        try { await rejected('body-change-' + path.basename(logical), () => run(selection.map(item => item.path === logical ? { ...item, bytes: bad.length, sha256: sha256(bad) } : item)), /Overriding output body\/imports changed/); }
        finally { await writeFile(row.filename, saved); }
    }
    await rejected('direct-typechecker-owner-swap', async () => { const row = selection.find(row => row.path.endsWith('/NewKotlinTypeChecker.kt')), alternate = path.join(outputRoot, 'TypeChecker.kt'); await copyFile(row.filename, alternate); return run(selection.map(item => item.path === row.path ? { ...item, filename: alternate } : item)); }, /Wrong genuine overriding consumer owner/);
    await rejected('missing-genuine-property-parent', () => run(selection.filter(row => row.path !== 'compiler-port-descriptor-property-constructors/PropertyDescriptorImpl.kt')), /Missing genuine overriding predecessor selection/);
    await rejected('missing-genuine-assertion-host', () => run(selection.filter(row => row.path !== 'compiler-port-assertions/CompilerAssertions.kt')), /Missing genuine overriding selected dependency/);
    await rejected('wrong-frozen-receipt', () => verifyDescriptorOverridingImplementations({ ...options, expectedReceiptSha256: '0'.repeat(64) }), /Immutable overriding receipt pin required/);
    const restoredPositive = await run(selection); assert.deepEqual(restoredPositive.predecessorRetainedSources, args.retainedSources);
    return { schemaVersion: 1, kind: 'genuine-descriptor-overriding-source-integrity', result: 'pass', historical: args.historical,
        actualSources: 3549, finalSources: 3552, restoredSources: 3549, sourceOutputs: 7, netAddedSources: 3, originalMetadataRowsRestored: 4,
        originalFullRowKeyOrderPreserved: true, allUnaffectedRowsIdentityAndBytesPreserved: true, extraIncomingMetadataPreserved: true,
        sourceLockSha256: prepared.receipt.sourceLockSha256, preparation: prepared.receipt, final: final.receipt, guards, guardCount: guards.length, restoredPositive: true,
        originalWholeExitCode: 1, newWholeCompilerExecuted: false, fullCommonClassWasmExecuted: false, browserProviderInitializationChosen: false, languageReadiness: false };
}
