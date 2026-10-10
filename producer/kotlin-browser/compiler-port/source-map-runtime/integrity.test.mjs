import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSourceContentBindings } from '../js-ast-consumer-bindings/source-content/prepare.mjs';
import { prepareSourceMapRuntimeReferences, prepareSourceMapRuntime, verifySourceMapRuntime } from './prepare.mjs';
import { verifySourceMapRuntimeFinalSources } from './final.mjs';
import { UTILS } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const lock = JSON.parse(await readFile(path.join(HERE, 'sources.lock.json'))), parent = path.join(REPO, 'out/kotlin-source-map-runtime'); await mkdir(parent, { recursive: true }); const output = await mkdtemp(path.join(parent, 'guards-'));
const predecessor = await prepareSourceContentBindings({ sourceRoot, outputRoot: path.join(output, 'predecessor') });
const reference = await prepareSourceMapRuntimeReferences(); const retainedSources = lock.selectedCallers.map(name => ({ path: name === UTILS ? lock.predecessor.componentRelativePath : name, compile: true, filename: name === UTILS ? predecessor.commonSources[0] : path.join(sourceRoot, name) }));
const base = { sourceRoot, runtimeSourceRoot: reference.sourceRoot, sourceContentComponent: predecessor, retainedSources }; let passed = 0;
async function check(name, action) { await action(); passed++; console.log('PASS ' + name); }
async function fresh() { const outputRoot = await mkdtemp(path.join(output, 'case-')); const prepared = await prepareSourceMapRuntime({ ...base, outputRoot }); return { ...base, outputRoot, prepared, receiptPath: prepared.receiptPath }; }
await check('Canonical preparation', async () => { await verifySourceMapRuntime(await fresh()); });
for (const name of ['entryRuntimeInstalled','originalGlobalStdoutParity','differentialValidated','sharedDependencies','predecessorBindings','callerClosure','selectedCallers']) await check('Changed receipt ' + name, async () => { const options = await fresh(); const receipt = JSON.parse(await readFile(options.receiptPath)); receipt[name] = Array.isArray(receipt[name]) ? [] : true; await writeFile(options.receiptPath, JSON.stringify(receipt)); await assert.rejects(verifySourceMapRuntime(options)); });
for (const index of [0,1,2,3,4]) await check('Changed output ' + index, async () => { const options = await fresh(); await writeFile(options.prepared.commonSources[index], 'mutation'); await assert.rejects(verifySourceMapRuntime(options)); });
await check('Missing actual selected caller', async () => { await assert.rejects(prepareSourceMapRuntime({ ...base, retainedSources: retainedSources.slice(1), outputRoot: await mkdtemp(path.join(output, 'missing-')) })); });
await check('Forged predecessor supplied receipt', async () => {
    const changed = structuredClone(predecessor); changed.receipt.fullJsAstUtilsBuilt = true;
    await assert.rejects(prepareSourceMapRuntime({ ...base, sourceContentComponent: changed, outputRoot: await mkdtemp(path.join(output, 'forged-')) }));
});
await check('Noncanonical predecessor filename', async () => {
    const changed = structuredClone(predecessor), other = path.join(output, 'other', lock.predecessor.componentRelativePath);
    await mkdir(path.dirname(other), { recursive: true }); await writeFile(other, await readFile(changed.commonSources[0])); changed.commonSources[0] = other;
    await assert.rejects(prepareSourceMapRuntime({ ...base, sourceContentComponent: changed, outputRoot: await mkdtemp(path.join(output, 'filename-')) }));
});
await check('Noncanonical predecessor receipt name', async () => {
    const changed = structuredClone(predecessor); changed.receiptPath = path.join(path.dirname(predecessor.receiptPath), 'other-receipt.json'); await writeFile(changed.receiptPath, await readFile(predecessor.receiptPath));
    await assert.rejects(prepareSourceMapRuntime({ ...base, sourceContentComponent: changed, outputRoot: await mkdtemp(path.join(output, 'receipt-')) }));
});
async function finalFresh() {
    const options = await fresh(); return { profileRoot: options.outputRoot, sourceRoot, runtimeSourceRoot: reference.sourceRoot, sourceContentComponent: predecessor,
        retainedSources: [...options.prepared.receipt.files.map((pin, index) => ({ path: pin.path, filename: options.prepared.commonSources[index], compile: true })),
            ...retainedSources.filter(item => item.path !== lock.predecessor.componentRelativePath).map(item => ({ ...item }))] };
}
await check('Final canonical selection', async () => { await verifySourceMapRuntimeFinalSources(await finalFresh()); });
await check('Final permitted assembly import', async () => {
    const options = await finalFresh(), filename = options.retainedSources[4].filename; const text = (await readFile(filename)).toString().replace('import org.jetbrains.kotlin.config.CompilerConfiguration\n', 'import org.jetbrains.kotlin.config.CompilerConfiguration\nimport kotlin.jvm.*\n');
    await writeFile(filename, text); await verifySourceMapRuntimeFinalSources({ ...options, allowedAddedImports: ['kotlin.jvm.*'] });
});
for (const kind of ['missing','filename','body','import','new-consumer','snapshot']) await check('Final rejects ' + kind, async () => {
    const options = await finalFresh();
    if (kind === 'missing') options.retainedSources.pop();
    if (kind === 'filename') { const original = options.retainedSources.at(-1), clone = path.join(output, 'clone.kt'); await writeFile(clone, await readFile(original.filename)); original.filename = clone; }
    if (kind === 'body') await writeFile(options.retainedSources[4].filename, (await readFile(options.retainedSources[4].filename)).toString().replace('configuration.put(', 'configuration.put(/* mutation */'));
    if (kind === 'import') await writeFile(options.retainedSources[4].filename, (await readFile(options.retainedSources[4].filename)).toString().replace('import org.jetbrains.kotlin.config.CompilerConfiguration\n', 'import org.jetbrains.kotlin.config.CompilerConfiguration\nimport kotlin.collections.*\n'));
    if (kind === 'new-consumer') { const filename = path.join(output, 'unknown.kt'); await writeFile(filename, 'fun newCaller() = requestSourceMapRuntime(configuration)'); options.retainedSources.push({ path: 'unknown.kt', filename, compile: true }); }
    if (kind === 'snapshot') await writeFile(path.join(options.profileRoot, 'caller-snapshot.json'), '[]');
    await assert.rejects(verifySourceMapRuntimeFinalSources(options));
});
console.log(JSON.stringify({ passed, failed: 0, skipped: 0, output }));
