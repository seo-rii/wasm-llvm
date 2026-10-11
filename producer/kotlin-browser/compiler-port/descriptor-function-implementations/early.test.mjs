import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { prepareTypeImplementations } from '../type-implementation/prepare.mjs';
import { prepareDescriptorBaseImplementations } from '../descriptor-base-implementations/prepare.mjs';
import { descriptorBaseFixture } from '../descriptor-base-implementations/fixture.mjs';
import { verifyCopyBuilderPlatform } from '../copy-builder-platform/prepare.mjs';
import { functionFixture } from './fixture.mjs';
import { prepareDescriptorFunctionImplementations, verifyDescriptorFunctionImplementations, verifyFinalDescriptorFunctionImplementations } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(process.argv[2]); await mkdir(root, { mode: 0o700 });
const late = await functionFixture();
const preparedTypeImplementations = await prepareTypeImplementations(late.sourceRoot, path.join(root, 'types'));
const preparedDescriptorBases = await prepareDescriptorBaseImplementations({ sourceRoot: late.sourceRoot, outputRoot: path.join(root, 'bases'), ...await descriptorBaseFixture() });
// The IR getter retained this genuine, complete, pristine CopyBuilder predecessor.
// Public verification reconstructs its original signature recipes and snapshots.
const builderRoot = path.join(late.historical.outputRoot, 'components/irPropertyTypeGetterReceipt/copy-builder');
const verified = await verifyCopyBuilderPlatform(builderRoot);
const preparedCopyBuilderPlatform = { outputRoot: builderRoot, receipt: verified.receipt };
const components = { preparedTypeImplementations, preparedDescriptorBases, preparedCopyBuilderPlatform };
const retainedSources = late.retainedSources.map(row => ({ ...row })), lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
for (const binding of lock.bindings) for (const pin of binding.files) {
    const filename = path.join(components[binding.name].outputRoot, pin.outputPath), bytes = await readRegular(filename), row = retainedSources.find(row => row.path === pin.path);
    assert(row); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
    Object.assign(row, { filename, bytes: bytes.length, sha256: sha256(bytes) });
}
for (const logical of lock.consumers) {
    const filename = path.join(root, 'selected-clones', logical), bytes = await readRegular(path.join(late.sourceRoot, logical));
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { mode: 0o600, flag: 'wx' });
    assert(!filename.startsWith(late.sourceRoot + path.sep));
    Object.assign(retainedSources.find(row => row.path === logical), { filename, bytes: bytes.length, sha256: sha256(bytes) });
}
const prepared = await prepareDescriptorFunctionImplementations({ sourceRoot: late.sourceRoot, outputRoot: path.join(root, 'prepared'), retainedSources, ...components });
assert.deepEqual(await verifyDescriptorFunctionImplementations({ outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256 }), prepared.receipt);
const actual = [...retainedSources, ...prepared.receipt.files.map(pin => ({ path: pin.path, filename: path.join(prepared.outputRoot, pin.path), bytes: pin.bytes, sha256: pin.sha256 }))];
const final = await verifyFinalDescriptorFunctionImplementations({ outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256, retainedSources: actual });
assert.deepEqual(final.predecessorRetainedSources, retainedSources);
const inputPins = [];
for (const name of ['early.test.mjs', 'fixture.mjs', 'prepare.mjs', 'sources.lock.json']) { const bytes = await readRegular(path.join(HERE, name)); inputPins.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
await writeJson(path.join(root, 'receipt.json'), { schemaVersion: 1, kind: 'genuine-descriptor-function-early-boundaries', result: 'pass', historical: late.historical,
    preparationReceiptSha256: prepared.receiptSha256, copiedConsumersOutsideSourceRoot: true, recordedPropertyImports: [],
    freshGenuineBaseAndTypePreparations: true, verifiedPristineCopyBuilderPredecessor: { outputRoot: builderRoot, receiptSha256: verified.receiptSha256 },
    checkedCanonicalDependencies: prepared.receipt.bindings.flatMap(binding => binding.files.map(({canonical,...pin}) => pin)), final: final.receipt, inputPins,
    limitation: 'The eleven dependency and two consumer boundaries model early canonical selection; other roster files remain the historical final files. No claim that this is an actual whole early build invocation.',
    fullCompilerBuilt: false, fullCommonClassesWasmExecuted: false, languageReadiness: false });
console.log(JSON.stringify({ result: 'pass', canonicalDependencies: 11, canonicalConsumers: 2, root }));
