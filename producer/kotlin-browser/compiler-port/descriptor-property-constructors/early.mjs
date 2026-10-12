import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { propertyConstructorFixture } from './fixture.mjs';
import { prepareDescriptorPropertyConstructors, verifyDescriptorPropertyConstructors, verifyFinalDescriptorPropertyConstructors } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(process.argv[2]); await mkdir(root, { mode: 0o700 });
const fixture = await propertyConstructorFixture(), lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
const rows = fixture.retainedSources.map(row => ({ ...row })), args = { ...fixture, recordedPropertyImports: [] }, canonicalReceipts = [];
for (const binding of lock.bindings) {
    const previous = fixture[binding.name], outputRoot = path.join(root, 'canonical-predecessors', binding.name);
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const receiptBytes = await readRegular(path.join(previous.outputRoot, 'receipt.json'));
    await writeFile(path.join(outputRoot, 'receipt.json'), receiptBytes, { mode: 0o600, flag: 'wx' });
    canonicalReceipts.push({ filename: path.join(previous.outputRoot, 'receipt.json'), bytes: receiptBytes.length, sha256: sha256(receiptBytes) });
    for (const pin of binding.files) {
        const bytes = await readRegular(path.join(HERE, pin.localPath)), filename = path.join(outputRoot, pin.outputPath);
        assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { mode: 0o600, flag: 'wx' });
        Object.assign(rows.find(row => row.path === pin.path), { filename, bytes: bytes.length, sha256: sha256(bytes) });
    }
    args[binding.name] = { outputRoot, receipt: JSON.parse(receiptBytes) };
}
for (const logical of lock.consumers) {
    const bytes = await readRegular(path.join(fixture.sourceRoot, logical)), filename = path.join(root, 'canonical-consumers', logical);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { mode: 0o600, flag: 'wx' });
    Object.assign(rows.find(row => row.path === logical), { filename, bytes: bytes.length, sha256: sha256(bytes) });
}
const prepared = await prepareDescriptorPropertyConstructors({ ...args, retainedSources: rows, outputRoot: path.join(root, 'prepared') });
assert.deepEqual(await verifyDescriptorPropertyConstructors({ outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256 }), prepared.receipt);
const own = prepared.receipt.files.map(pin => ({ path: pin.path, filename: path.join(prepared.outputRoot, pin.path), bytes: pin.bytes, sha256: pin.sha256 }));
const replacements = new Map(own.map(row => [row.path, row]));
const selection = [...rows.map(row => replacements.get(row.path) ?? row), ...own.filter(row => row.path.startsWith('compiler-port-descriptor-property-constructors/'))];
const final = await verifyFinalDescriptorPropertyConstructors({ outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256, retainedSources: selection });
assert.deepEqual(final.predecessorRetainedSources, rows);
const filePins = canonicalReceipts.concat(rows.map(row => ({ filename: row.filename, bytes: row.bytes, sha256: row.sha256 })));
for (const name of ['early.mjs', 'fixture.mjs', 'prepare.mjs', 'sources.lock.json']) {
    const filename = path.join(HERE, name), bytes = await readRegular(filename); filePins.push({ filename, bytes: bytes.length, sha256: sha256(bytes) });
}
await writeJson(path.join(root, 'receipt.json'), { schemaVersion: 1, kind: 'genuine-descriptor-property-constructor-early-boundaries', result: 'pass', historical: fixture.historical,
    checkedCanonicalDependencies: lock.bindings.flatMap(binding => binding.files).length, checkedCanonicalConsumers: lock.consumers.length,
    recordedPropertyImports: [], preparationReceiptSha256: prepared.receiptSha256, final: final.receipt, filePins,
    limitation: 'The eighteen relevant boundary owners model early canonical production preparation with copied genuine predecessor receipts. Other retained sources remain the historical final selection; this is not a whole early build invocation.',
    fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false });
console.log(JSON.stringify({ result: 'pass', canonicalDependencies: lock.bindings.flatMap(binding => binding.files).length, canonicalConsumers: lock.consumers.length, root }));
