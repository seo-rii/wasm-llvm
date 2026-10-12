import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../../scripts/source.mjs';
import { prepareDescriptorTypeAliasConstructorBindings, verifyDescriptorTypeAliasConstructorBindings, verifyFinalDescriptorTypeAliasConstructorBindings, OUTPUT_PREFIX } from './prepare.mjs';
import { TARGET, CLASS_CONSTRUCTOR } from './transform.mjs';
import { typeAliasConstructorFixture } from './fixture.mjs';
export async function typeAliasIntegrity(outputRoot) {
    const args = await typeAliasConstructorFixture(), prepared = await prepareDescriptorTypeAliasConstructorBindings({ ...args, outputRoot: path.join(outputRoot, 'prepared') });
    const rows = args.retainedSources.map(row => { const p = prepared.receipt.files.find(p => p.path === row.path); return p ? { ...row, filename: path.join(prepared.outputRoot, row.path), bytes: p.bytes, sha256: p.sha256 } : row; });
    const added = prepared.receipt.files.find(p => p.path.startsWith(OUTPUT_PREFIX)); rows.push({ path: added.path, filename: path.join(prepared.outputRoot, added.path), bytes: added.bytes, sha256: added.sha256, compile: true });
    const options = { outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256, retainedSources: rows, recordedPropertyImports: args.recordedPropertyImports }, call = retainedSources => verifyFinalDescriptorTypeAliasConstructorBindings({ ...options, retainedSources });
    await verifyDescriptorTypeAliasConstructorBindings(options); const final = await call(rows); assert.equal(rows.length, 3550); assert.deepEqual(final.predecessorRetainedSources, args.retainedSources);
    for (const [i, row] of final.predecessorRetainedSources.entries()) { assert.deepEqual(Object.keys(row), Object.keys(args.retainedSources[i])); if (row.path !== TARGET) assert.equal(row, args.retainedSources[i]); }
    assert.equal(prepared.predecessorBindings.length, 1); assert.equal(prepared.predecessorBindings[0].component, 'descriptorPlatformSignaturesReceipt');
    const guards = [];
    async function reject(name, run, reason) { let error; try { await run(); } catch (e) { error = e; } assert(error, 'Typealias guard accepted: ' + name); assert.match(String(error.message), reason, name); guards.push({ name, result: 'rejected', reason: String(error.message), expectedReason: reason.source, reasonMatched: true }); }
    await reject('missing-complete-consumer', () => call(rows.filter(r => r.path !== TARGET)), /Missing typealias output/);
    await reject('missing-narrow-helper', () => call(rows.filter(r => r.path !== added.path)), /Missing typealias output/);
    await reject('inactive-target', () => call(rows.map(r => r.path === TARGET ? { ...r, compile: false } : r)), /active rows/);
    await reject('duplicate-path', () => call([...rows, rows[0]]), /Duplicate typealias logical path/);
    await reject('caller-blessed-import', () => verifyFinalDescriptorTypeAliasConstructorBindings({ ...options, recordedPropertyImports: [...args.recordedPropertyImports, 'foreign.permission'] }), /Typealias final imports must match locked assembly/);
    for (const logical of [TARGET, added.path]) { const row = rows.find(r => r.path === logical), copy = path.join(outputRoot, 'copy-' + guards.length + '.kt'); await copyFile(row.filename, copy);
        await reject('same-body-owner-' + path.basename(logical), () => call(rows.map(r => r.path === logical ? { ...r, filename: copy } : r)), /Wrong typealias output owner/);
        const original = await readFile(row.filename), bad = Buffer.concat([original, Buffer.from('\n// forbidden semantic mutation\n')]); await writeFile(row.filename, bad);
        try { await reject('body-change-' + path.basename(logical), () => call(rows.map(r => r.path === logical ? { ...r, bytes: bad.length, sha256: sha256(bad) } : r)), /Typealias output body\/imports changed/); } finally { await writeFile(row.filename, original); } }
    await reject('missing-own-kotlin-constructor-contract', () => call(rows.filter(r => r.path !== CLASS_CONSTRUCTOR)), /Missing typealias parent selection/);
    await reject('missing-real-function-parent', () => call(rows.filter(r => r.path !== 'compiler-port-descriptor-functions/FunctionDescriptorImpl.kt')), /Missing typealias parent selection/);
    await reject('missing-assertion-host', () => call(rows.filter(r => r.path !== 'compiler-port-assertions/CompilerAssertions.kt')), /Missing typealias selected dependency/);
    await reject('wrong-external-receipt-digest', () => verifyDescriptorTypeAliasConstructorBindings({ ...options, expectedReceiptSha256: '0'.repeat(64) }), /Immutable typealias receipt pin required/);
    const extra = await call(rows.map(r => r.path === TARGET ? { ...r, note: { preserve: true } } : r)); assert.deepEqual(extra.predecessorRetainedSources.find(r => r.path === TARGET).note, { preserve: true });
    const restored = await call(rows); assert.deepEqual(restored.predecessorRetainedSources, args.retainedSources);
    return { schemaVersion: 1, kind: 'genuine-typealias-constructor-source-integrity', result: 'pass', historical: args.historical, preparation: prepared.receipt, predecessorBindings: prepared.predecessorBindings, final: final.receipt,
        actualSources: 3549, finalSources: 3550, restoredSources: 3549, outputs: 2, netAddedSources: 1, fullMetadataAndKeyOrderInverse: true, unaffectedRowsSameObjectsAndBytes: true, extraIncomingMetadataPreserved: true,
        guards, guardCount: guards.length, restoredPositive: true, originalWholeCompilerExitCode: 1, newWholeCompilerExecuted: false, fullCommonConsumerWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
}
