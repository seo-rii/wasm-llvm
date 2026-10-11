import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { assembleImports } from '../type-substitutor-getter/prepare.mjs';
import { substitutionFixture } from './fixture.mjs';
import { prepareDescriptorSubstitutor, verifyDescriptorSubstitutor, verifyFinalDescriptorSubstitutor } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(process.argv[2]); await mkdir(root, { mode: 0o700 });
const fixture = await substitutionFixture(), prepared = await prepareDescriptorSubstitutor({ ...fixture, outputRoot: path.join(root, 'prepared') });
const originalRows = fixture.retainedSources;
assert.deepEqual(await verifyDescriptorSubstitutor({ outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256 }), prepared.receipt);
const additions = prepared.receipt.files.map(pin => ({ ...pin, filename: path.join(prepared.outputRoot, pin.path) }));
let selected = [...originalRows, ...additions];
const runFinal = (rows = selected, imports = fixture.recordedPropertyImports, hash = prepared.receiptSha256) => verifyFinalDescriptorSubstitutor({ outputRoot: prepared.outputRoot, expectedReceiptSha256: hash, retainedSources: rows, recordedPropertyImports: imports });
const positive = await runFinal(); assert.deepEqual(positive.predecessorRetainedSources, originalRows);
const negatives = [];
async function negative(name, action) { await assert.rejects(action); negatives.push(name); }
await negative('missing-output', () => runFinal(selected.slice(0, -1)));
await negative('duplicate-output-path-and-owner', () => runFinal([...selected, selected.at(-1)]));
const target = additions[0], canonical = await readRegular(target.filename);
await writeFile(target.filename, Buffer.concat([canonical, Buffer.from('\n// unauthorized source body\n')]));
const changed = await readRegular(target.filename);
await negative('rehashed-source-body', () => runFinal(selected.map(row => row.path === target.path ? { ...row, bytes: changed.length, sha256: sha256(changed) } : row)));
await writeFile(target.filename, canonical);
const switched = path.join(root, 'switched.kt'); await writeFile(switched, canonical, { flag: 'wx', mode: 0o600 });
await negative('same-body-wrong-owner', () => runFinal(selected.map(row => row.path === target.path ? { ...row, filename: switched } : row)));
const java = prepared.receipt.replacedOriginalPaths[0], javaFilename = path.join(prepared.outputRoot, 'reference', java), javaBytes = await readRegular(javaFilename);
await negative('reintroduced-original-java', () => runFinal([...selected, { path: java, filename: javaFilename, bytes: javaBytes.length, sha256: sha256(javaBytes) }]));
const unknownPath = 'compiler-port-descriptor-substitutor/Unknown.kt';
await negative('unrecorded-component-output', () => runFinal([...selected, { path: unknownPath, filename: switched, bytes: canonical.length, sha256: sha256(canonical) }]));
const receiptPath = prepared.receiptPath, savedReceipt = await readRegular(receiptPath), forged = JSON.parse(savedReceipt); forged.selectedInventory.pop();
await writeFile(receiptPath, JSON.stringify(forged));
await negative('externally-pinned-receipt-forgery', () => runFinal()); await writeFile(receiptPath, savedReceipt);
const referencePath = path.join(prepared.outputRoot, 'reference', java), savedReference = await readRegular(referencePath);
await writeFile(referencePath, Buffer.concat([savedReference, Buffer.from('\n')]));
await negative('original-reference-forgery', () => runFinal()); await writeFile(referencePath, savedReference);
await negative('missing-real-predecessor', () => runFinal(selected.filter(row => row.path !== prepared.receipt.bindings[0].name && row.path !== 'compiler-port-descriptor-bases/DescriptorBaseImplementations.kt')));
// Only newly created outputs are mutated; historical outputs stay byte-for-byte intact.
for (const row of additions) {
    const body = assembleImports(await readRegular(row.filename), fixture.recordedPropertyImports); await writeFile(row.filename, body);
    Object.assign(row, { bytes: body.length, sha256: sha256(body) });
}
selected = [...originalRows, ...additions];
const assembled = await runFinal(); assert.deepEqual(assembled.predecessorRetainedSources, originalRows);
await negative('duplicated-assembly-imports', () => runFinal(selected, [...fixture.recordedPropertyImports, fixture.recordedPropertyImports[0]]));
const corruptedImport = (await readRegular(target.filename)).toString().replace(/^package[^\n]*\n/m, '$&import unauthorized.compiler.*\n');
await writeFile(target.filename, corruptedImport);
await negative('unrecorded-assembly-import', () => runFinal(selected.map(row => row.path === target.path ? { ...row, bytes: Buffer.byteLength(corruptedImport), sha256: sha256(Buffer.from(corruptedImport)) } : row)));
const restored = assembleImports(canonical, fixture.recordedPropertyImports); await writeFile(target.filename, restored);
assert.deepEqual((await runFinal()).predecessorRetainedSources, originalRows);
const inputPins = [];
for (const name of ['integrity.mjs', 'fixture.mjs', 'prepare.mjs', 'sources.lock.json']) { const bytes = await readRegular(path.join(HERE, name)); inputPins.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
await writeJson(path.join(root, 'receipt.json'), { schemaVersion: 1, kind: 'genuine-descriptor-substitution-integrity', result: 'pass', historical: fixture.historical,
    preparationReceiptSha256: prepared.receiptSha256, positive: assembled.receipt, negatives, exactPredecessorInventoryRestored: true,
    immutableHistoricalFilesModified: false, inputPins, fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false });
console.log(JSON.stringify({ result: 'pass', negatives: negatives.length, selectedSources: assembled.receipt.selectedSources, root }));
