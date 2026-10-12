import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { assembleImports } from '../type-substitutor-getter/prepare.mjs';
import { lazyMutableImplementationFixture } from './fixture.mjs';
import { OUTPUT_PREFIX, prepareDescriptorLazyMutableImplementations, verifyDescriptorLazyMutableImplementations, verifyFinalDescriptorLazyMutableImplementations } from './prepare.mjs';
import { SUSPEND_FUNCTIONS, DESERIALIZED_PARAMETER } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(process.argv[2]); await mkdir(root, { mode: 0o700 });
const fixture = await lazyMutableImplementationFixture();
fixture.retainedSources = fixture.retainedSources.map((row, i) => ({ ...row, selectionMetadata: 'preserved-' + i }));
const prepared = await prepareDescriptorLazyMutableImplementations({ ...fixture, outputRoot: path.join(root, 'prepared') });
const originalRows = fixture.retainedSources;
assert.deepEqual(await verifyDescriptorLazyMutableImplementations({ outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256 }), prepared.receipt);
const additions = prepared.receipt.files.map(pin => ({ path: pin.path, bytes: pin.bytes, sha256: pin.sha256, filename: path.join(prepared.outputRoot, pin.path), compile: true }));
const outputs = new Map(additions.map(row => [row.path, row]));
const withOutputs = () => [...originalRows.map(row => outputs.has(row.path) ? { ...row, ...outputs.get(row.path) } : row), ...additions.filter(row => row.path.startsWith(OUTPUT_PREFIX))];
let selected = withOutputs();
const runFinal = (rows = selected, imports = fixture.recordedPropertyImports, hash = prepared.receiptSha256) => verifyFinalDescriptorLazyMutableImplementations({ outputRoot: prepared.outputRoot, expectedReceiptSha256: hash, retainedSources: rows, recordedPropertyImports: imports });
const positive = await runFinal(); assert.deepEqual(positive.predecessorRetainedSources, originalRows);
assert.deepEqual(positive.predecessorRetainedSources.map(row => Object.keys(row)), originalRows.map(row => Object.keys(row)));
assert.equal(positive.receipt.selectedSources, 3553); assert.equal(positive.receipt.restoredContractPredecessors.length, 1);
const negatives = [];
async function negative(name, action) { await assert.rejects(action); negatives.push(name); }
await negative('missing-class-output', () => runFinal(selected.filter(row => row.path !== OUTPUT_PREFIX + 'MutableClassDescriptor.kt')));
await negative('missing-writable-helper', () => runFinal(selected.filter(row => row.path !== OUTPUT_PREFIX + 'LazyMutableDescriptorProperties.kt')));
await negative('missing-genuine-suspend-consumer', () => runFinal(selected.filter(row => row.path !== SUSPEND_FUNCTIONS)));
await negative('missing-genuine-deserialized-consumer', () => runFinal(selected.filter(row => row.path !== DESERIALIZED_PARAMETER)));
await negative('old-consumer-owner', () => runFinal(selected.map(row => row.path === SUSPEND_FUNCTIONS ? originalRows.find(row => row.path === SUSPEND_FUNCTIONS) : row)));
await negative('duplicate-path-and-owner', () => runFinal([...selected, selected.at(-1)]));
const target = additions[0], canonical = await readRegular(target.filename);
await writeFile(target.filename, Buffer.concat([canonical, Buffer.from('\n// unauthorized source body\n')]));
const changed = await readRegular(target.filename);
await negative('rehashed-source-body', () => runFinal(selected.map(row => row.path === target.path ? { ...row, bytes: changed.length, sha256: sha256(changed) } : row)));
await writeFile(target.filename, canonical);
const switched = path.join(root, 'switched.kt'); await writeFile(switched, canonical, { flag: 'wx', mode: 0o600 });
await negative('same-body-wrong-owner', () => runFinal(selected.map(row => row.path === target.path ? { ...row, filename: switched } : row)));
const java = prepared.receipt.replacedOriginalPaths[0], javaFilename = path.join(prepared.outputRoot, 'reference', java), javaBytes = await readRegular(javaFilename);
await negative('original-java-reintroduced', () => runFinal([...selected, { path: java, filename: javaFilename, bytes: javaBytes.length, sha256: sha256(javaBytes) }]));
await negative('unrecorded-component-output', () => runFinal([...selected, { path: OUTPUT_PREFIX + 'Unknown.kt', filename: switched, bytes: canonical.length, sha256: sha256(canonical) }]));
const savedReceipt = await readRegular(prepared.receiptPath), forged = JSON.parse(savedReceipt); forged.selectedInventory.pop();
await writeFile(prepared.receiptPath, JSON.stringify(forged));
await negative('externally-pinned-receipt-forgery', () => runFinal()); await writeFile(prepared.receiptPath, savedReceipt);
const savedReference = await readRegular(javaFilename); await writeFile(javaFilename, Buffer.concat([savedReference, Buffer.from('\n')]));
await negative('original-reference-forgery', () => runFinal()); await writeFile(javaFilename, savedReference);
await negative('missing-genuine-class-predecessor', () => runFinal(selected.filter(row => row.path !== 'compiler-port-descriptor-classes/ClassDescriptorBase.kt')));
await negative('missing-genuine-type-parameter-predecessor', () => runFinal(selected.filter(row => row.path !== 'compiler-port-descriptor-substitutor/AbstractTypeParameterDescriptor.kt')));
for (const row of additions) {
    const body = assembleImports(await readRegular(row.filename), fixture.recordedPropertyImports); await writeFile(row.filename, body);
    Object.assign(row, { bytes: body.length, sha256: sha256(body) });
}
selected = withOutputs();
const assembled = await runFinal(); assert.deepEqual(assembled.predecessorRetainedSources, originalRows);
await negative('duplicated-assembly-imports', () => runFinal(selected, [...fixture.recordedPropertyImports, fixture.recordedPropertyImports[0]]));
const corrupted = (await readRegular(target.filename)).toString().replace(/^package[^\n]*\n/m, '$&import unauthorized.compiler.*\n');
await writeFile(target.filename, corrupted);
await negative('unrecorded-assembly-import', () => runFinal(selected.map(row => row.path === target.path ? { ...row, bytes: Buffer.byteLength(corrupted), sha256: sha256(Buffer.from(corrupted)) } : row)));
await writeFile(target.filename, assembleImports(canonical, fixture.recordedPropertyImports));
const consumer = additions.find(row => row.path === SUSPEND_FUNCTIONS), consumerBytes = await readRegular(consumer.filename);
const missingSetterImport = Buffer.from(consumerBytes.toString().replace('import org.jetbrains.kotlin.portable.lazymutabledescriptors.visibility\n', ''));
await writeFile(consumer.filename, missingSetterImport);
await negative('missing-exact-local-setter-import', () => runFinal(selected.map(row => row.path === consumer.path ? { ...row, bytes: missingSetterImport.length, sha256: sha256(missingSetterImport) } : row)));
await writeFile(consumer.filename, consumerBytes);
assert.deepEqual((await runFinal()).predecessorRetainedSources, originalRows);
await negative('source-output-overlap', () => prepareDescriptorLazyMutableImplementations({ ...fixture, outputRoot: fixture.sourceRoot }));
await negative('existing-output-reuse', () => prepareDescriptorLazyMutableImplementations({ ...fixture, outputRoot: prepared.outputRoot }));
await negative('already-selected-component', () => prepareDescriptorLazyMutableImplementations({ ...fixture, retainedSources: selected, outputRoot: path.join(root, 'duplicate-selection') }));
const inputPins = [];
for (const name of ['integrity.mjs', 'fixture.mjs', 'prepare.mjs', 'transform.mjs', 'sources.lock.json']) { const bytes = await readRegular(path.join(HERE, name)); inputPins.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
const filePins = originalRows.map(row => ({ filename: row.filename, bytes: row.bytes, sha256: row.sha256 }));
for (const pin of inputPins) filePins.push({ filename: path.join(HERE, pin.path), bytes: pin.bytes, sha256: pin.sha256 });
for (const name of ['compiler-build-receipt.json', 'compiler-klib.args']) {
    const filename = path.join(fixture.historical.outputRoot, name), bytes = await readRegular(filename, 64 * 1024 * 1024); filePins.push({ filename, bytes: bytes.length, sha256: sha256(bytes) });
}
for (const pin of filePins) { const bytes = await readRegular(pin.filename, 64 * 1024 * 1024); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); }
await writeJson(path.join(root, 'receipt.json'), { schemaVersion: 1, kind: 'genuine-descriptor-lazy-mutable-integrity', result: 'pass', historical: fixture.historical,
    preparationReceiptSha256: prepared.receiptSha256, positive: assembled.receipt, negatives, exactPredecessorInventoryRestored: true, exactContractPredecessorsRestored: 1,
    immutableHistoricalFilesModified: false, inputPins, filePins, fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false });
console.log(JSON.stringify({ result: 'pass', negatives: negatives.length, selectedSources: assembled.receipt.selectedSources, root }));
