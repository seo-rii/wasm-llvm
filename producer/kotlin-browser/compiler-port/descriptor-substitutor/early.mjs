import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { verifyDescriptorFunctionImplementations } from '../descriptor-function-implementations/prepare.mjs';
import { verifyDescriptorBaseImplementations } from '../descriptor-base-implementations/prepare.mjs';
import { verifyTypeImplementationPreparation } from '../type-implementation/prepare.mjs';
import { substitutionFixture } from './fixture.mjs';
import { prepareDescriptorSubstitutor, verifyDescriptorSubstitutor, verifyFinalDescriptorSubstitutor } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const root = path.resolve(process.argv[2]); await mkdir(root, { mode: 0o700 });
const late = await substitutionFixture(), priorRoot = path.join(REPO, 'out/kotlin-function-early2-1791707602490312088');
const priorReceipt = await readRegular(path.join(priorRoot, 'receipt.json')), prior = JSON.parse(priorReceipt);
assert.equal(prior.kind, 'genuine-descriptor-function-early-boundaries'); assert.equal(prior.result, 'pass');
const components = {};
for (const [name, directory] of [['preparedDescriptorBases', 'bases'], ['preparedTypeImplementations', 'types'], ['preparedFunctions', 'prepared']]) {
    const outputRoot = path.join(priorRoot, directory), receiptBytes = await readRegular(path.join(outputRoot, 'receipt.json'));
    components[name] = { outputRoot, receipt: JSON.parse(receiptBytes) };
}
assert.deepEqual(await verifyDescriptorBaseImplementations(components.preparedDescriptorBases.outputRoot), components.preparedDescriptorBases.receipt);
await verifyTypeImplementationPreparation(components.preparedTypeImplementations.outputRoot);
const functionReceiptBytes = await readRegular(path.join(components.preparedFunctions.outputRoot, 'receipt.json'));
await verifyDescriptorFunctionImplementations({ outputRoot: components.preparedFunctions.outputRoot, expectedReceiptSha256: sha256(functionReceiptBytes) });
const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json'))), selected = late.retainedSources.map(row => ({ ...row }));
for (const binding of lock.bindings) for (const pin of binding.files) {
    const filename = path.join(components[binding.name].outputRoot, pin.outputPath), bytes = await readRegular(filename);
    assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
    Object.assign(selected.find(row => row.path === pin.path), { filename, bytes: bytes.length, sha256: sha256(bytes) });
}
for (const logical of lock.consumers) {
    const bytes = await readRegular(path.join(late.sourceRoot, logical)), filename = path.join(root, 'selection-clones', logical);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { mode: 0o600, flag: 'wx' });
    Object.assign(selected.find(row => row.path === logical), { filename, bytes: bytes.length, sha256: sha256(bytes) });
}
const prepared = await prepareDescriptorSubstitutor({ sourceRoot: late.sourceRoot, outputRoot: path.join(root, 'prepared'), retainedSources: selected, ...components });
assert.deepEqual(await verifyDescriptorSubstitutor({ outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256 }), prepared.receipt);
const final = await verifyFinalDescriptorSubstitutor({ outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256,
    retainedSources: [...selected, ...prepared.receipt.files.map(pin => ({ ...pin, filename: path.join(prepared.outputRoot, pin.path) }))] });
assert.deepEqual(final.predecessorRetainedSources, selected);
const inputPins = [];
for (const name of ['early.mjs', 'fixture.mjs', 'prepare.mjs', 'sources.lock.json']) { const bytes = await readRegular(path.join(HERE, name)); inputPins.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
await writeJson(path.join(root, 'receipt.json'), { schemaVersion: 1, kind: 'genuine-descriptor-substitution-early-boundaries', result: 'pass', historical: late.historical,
    verifiedFunctionEarlyPreparation: { filename: path.join(priorRoot, 'receipt.json'), bytes: priorReceipt.length, sha256: sha256(priorReceipt) },
    checkedCanonicalDependencies: 7, checkedCanonicalConsumers: 4, recordedPropertyImports: [], preparationReceiptSha256: prepared.receiptSha256,
    final: final.receipt, inputPins,
    limitation: 'The eleven relevant boundary owners model early canonical production preparation. Other retained files remain the historical final selection; this is not a whole early build invocation.',
    fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false });
console.log(JSON.stringify({ result: 'pass', canonicalDependencies: 7, canonicalConsumers: 4, root }));
