import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { assembleImports } from '../type-substitutor-getter/prepare.mjs';
import { verifyFinalDescriptorBaseImplementations } from '../descriptor-base-implementations/prepare.mjs';
import { verifyFinalIrPropertyTypeGetter } from '../ir-property-type-getter/prepare.mjs';
import { verifyFinalCopyBuilderPlatform } from '../copy-builder-platform/prepare.mjs';
import { verifyFinalDescriptorPlatformSignatures } from '../descriptor-platform-signatures/prepare.mjs';
import { functionFixture } from './fixture.mjs';
import { prepareDescriptorFunctionImplementations, verifyDescriptorFunctionImplementations, verifyFinalDescriptorFunctionImplementations } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(process.argv[2]); await mkdir(root, { mode: 0o700 });
const fixture = await functionFixture(), prepared = await prepareDescriptorFunctionImplementations({ ...fixture, outputRoot: path.join(root, 'prepared') });
assert.deepEqual(await verifyDescriptorFunctionImplementations({ outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256 }), prepared.receipt);
const own = [];
for (const pin of prepared.receipt.files) {
    const filename = path.join(prepared.outputRoot, pin.path), canonical = await readRegular(filename), bytes = assembleImports(canonical, fixture.recordedPropertyImports);
    await writeFile(filename, bytes, { mode: 0o600 }); own.push({ path: pin.path, filename, bytes: bytes.length, sha256: sha256(bytes) });
}
const rows = [...fixture.retainedSources, ...own], options = { outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256,
    retainedSources: rows, recordedPropertyImports: fixture.recordedPropertyImports };
const positive = await verifyFinalDescriptorFunctionImplementations(options);
assert.deepEqual(positive.predecessorRetainedSources, fixture.retainedSources);
const tests = [];
async function rejects(name, body, pattern) { await assert.rejects(body, pattern); tests.push({ name, result: 'pass' }); }
await rejects('missing-output', () => verifyFinalDescriptorFunctionImplementations({ ...options, retainedSources: rows.slice(0, -1) }), /Missing function implementation output/);
await rejects('duplicate-logical-path', () => verifyFinalDescriptorFunctionImplementations({ ...options, retainedSources: rows.concat(own[0]) }), /Duplicate function selection path/);
const identical = path.join(root, 'identical.kt'); await copyFile(own[0].filename, identical);
await rejects('identical-output-wrong-owner', () => verifyFinalDescriptorFunctionImplementations({ ...options, retainedSources: rows.map(row => row === own[0] ? { ...row, filename: identical } : row) }), /Wrong function implementation owner/);
const prior = await readRegular(own[0].filename), changed = Buffer.concat([prior, Buffer.from('\n// unrecorded body\n')]);
await writeFile(own[0].filename, changed);
await rejects('updated-digest-does-not-authorize-changed-body', () => verifyFinalDescriptorFunctionImplementations({ ...options, retainedSources: rows.map(row => row === own[0] ? { ...row, bytes: changed.length, sha256: sha256(changed) } : row) }), /Function implementation body\/imports changed/);
await writeFile(own[0].filename, prior);
await rejects('unrecorded-imports', () => verifyFinalDescriptorFunctionImplementations({ ...options, recordedPropertyImports: [] }), /Genuine function dependency body\/imports changed/);
await rejects('missing-receipt-pin', () => verifyFinalDescriptorFunctionImplementations({ ...options, expectedReceiptSha256: undefined }), /Function preparation receipt pin/);
const receiptPath = prepared.receiptPath, receiptBytes = await readRegular(receiptPath); await writeFile(receiptPath, Buffer.concat([receiptBytes, Buffer.from(' ')]));
await rejects('preparation-receipt-mutation', () => verifyFinalDescriptorFunctionImplementations(options), /Function preparation receipt pin/); await writeFile(receiptPath, receiptBytes);
const dependency = fixture.retainedSources.find(row => row.path.endsWith('/FunctionDescriptor.kt'));
const depCopy = path.join(root, 'dependency.kt'); await copyFile(dependency.filename, depCopy);
await rejects('identical-contract-wrong-owner', () => verifyFinalDescriptorFunctionImplementations({ ...options, retainedSources: rows.map(row => row === dependency ? { ...row, filename: depCopy } : row) }), /Wrong genuine function dependency owner/);
const consumer = fixture.retainedSources.find(row => row.path.endsWith('/FunctionInvokeDescriptor.kt'));
const consumerCopy = path.join(root, 'consumer.kt'); await copyFile(consumer.filename, consumerCopy);
await rejects('identical-consumer-wrong-owner', () => verifyFinalDescriptorFunctionImplementations({ ...options, retainedSources: rows.map(row => row === consumer ? { ...row, filename: consumerCopy } : row) }), /Wrong genuine writable-property consumer owner/);
const java = prepared.receipt.replacedOriginalPaths[0], javaFilename = path.join(fixture.sourceRoot, java), javaBytes = await readRegular(javaFilename);
await rejects('original-java-reintroduced', () => verifyFinalDescriptorFunctionImplementations({ ...options, retainedSources: rows.concat({ path: java, filename: javaFilename, bytes: javaBytes.length, sha256: sha256(javaBytes) }) }), /Original Java function implementation was reintroduced/);
const restored = await verifyFinalDescriptorFunctionImplementations(options); assert.deepEqual(restored, positive);
// Replay the old public guards on the real whole-build source list after our exact
// three-source reverse. This is executable chain evidence, not just a map comparison.
const components = path.join(fixture.historical.outputRoot, 'components'), allowedAddedImports = ['kotlin.jvm.*', ...fixture.recordedPropertyImports, 'org.jetbrains.kotlin.portable.assertions.compilerAssert as assert'];
const bases = await verifyFinalDescriptorBaseImplementations({ outputRoot: path.join(components, 'descriptorBaseImplementationsReceipt'), retainedSources: restored.predecessorRetainedSources, recordedPropertyImports: fixture.recordedPropertyImports });
const ir = await verifyFinalIrPropertyTypeGetter({ profileRoot: path.join(components, 'irPropertyTypeGetterReceipt'), retainedSources: bases.predecessorRetainedSources, allowedAddedImports });
const builders = await verifyFinalCopyBuilderPlatform({ profileRoot: path.join(components, 'copyBuilderPlatformReceipt'), retainedSources: ir.predecessorRetainedSources, allowedAddedImports });
const signatures = await verifyFinalDescriptorPlatformSignatures({ profileRoot: path.join(components, 'descriptorPlatformSignaturesReceipt'), retainedSources: builders.predecessorRetainedSources, allowedAddedImports });
const filePins = [];
for (const name of ['prepare.mjs', 'fixture.mjs', 'prepare.test.mjs', 'sources.lock.json', 'FunctionDescriptorImpl.kt', 'SimpleFunctionDescriptorImpl.kt', 'FunctionDescriptorProperties.kt']) {
    const bytes = await readRegular(path.join(HERE, name)); filePins.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
}
await writeJson(path.join(root, 'receipt.json'), { schemaVersion: 1, kind: 'genuine-descriptor-function-integrity', result: 'pass', historical: fixture.historical,
    preparationReceiptSha256: prepared.receiptSha256, positive: positive.receipt, negatives: tests, restoredPositive: true, exactPredecessorInventoryRestored: true,
    oldPublicFinalChain: { bases: bases.receipt, ir: ir.receipt, builders: builders.receipt, signatures }, filePins,
    fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false });
console.log(JSON.stringify({ result: 'pass', negatives: tests.length, actualSources: fixture.retainedSources.length, finalSources: rows.length, root }));
