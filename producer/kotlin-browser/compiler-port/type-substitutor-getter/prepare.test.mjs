import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { getterFixture } from './fixture.mjs';
import { assembleImports, calls, OUTPUT, prepareTypeSubstitutorGetter, verifyTypeSubstitutorGetter, verifyFinalTypeSubstitutorGetter } from './prepare.mjs';
const outputRoot = path.resolve(process.argv[2]); await mkdir(outputRoot, { recursive: false, mode: 0o700 });
const fixture = await getterFixture(path.join(outputRoot, 'fixture'));
const prepared = await prepareTypeSubstitutorGetter({ ...fixture, outputRoot: path.join(outputRoot, 'prepared') });
const checks = [];
async function check(name, block) { await block(); checks.push(name); }
const helper = { ...prepared.receipt.files[0], filename: prepared.commonSources[0] };
const retained = [...fixture.retainedSources, helper];
const final = () => verifyFinalTypeSubstitutorGetter({ outputRoot: prepared.outputRoot, retainedSources: retained, recordedPropertyImports: fixture.recordedPropertyImports });
await check('full-actual-inventory-preparation', async () => assert.deepEqual(await verifyTypeSubstitutorGetter(prepared.outputRoot), prepared.receipt));
await check('full-canonical-final', async () => assert.equal((await final()).observedCalls.flatMap(item => item.calls).length, 5));
await check('duplicate-logical-path-rejected', async () => { retained.push(retained[0]); try { await assert.rejects(final, /Duplicate selected logical path/); } finally { retained.pop(); } });
await check('wrong-owner-identical-bytes-rejected', async () => {
    const selected = retained.find(item => item.path.endsWith('/TypeSubstitutor.kt')), original = selected.filename, copy = path.join(outputRoot, 'CopiedTypeSubstitutor.kt');
    await writeFile(copy, await readRegular(original), { flag: 'wx', mode: 0o600 }); selected.filename = copy;
    try { await assert.rejects(final, /Wrong genuine getter dependency owner/); } finally { selected.filename = original; }
});
await check('bound-original-consumer-cannot-switch-to-canonical-cache-owner', async () => {
    const selected = retained.find(item => item.path.endsWith('/SubstitutingScope.kt')), original = selected.filename;
    selected.filename = path.join(fixture.sourceRoot, selected.path); assert.notEqual(original, selected.filename);
    try { await assert.rejects(final, /Wrong genuine getter dependency owner/); } finally { selected.filename = original; }
});
await check('getter-body-tampering-rejected-even-with-new-selection-hash', async () => {
    const original = await readRegular(helper.filename), bad = Buffer.from(original.toString().replace('get() = isEmpty()', 'get() = false'));
    await writeFile(helper.filename, bad); helper.bytes = bad.length; helper.sha256 = sha256(bad);
    try { await assert.rejects(final, /Typed getter output changed/); } finally { await writeFile(helper.filename, original); helper.bytes = original.length; helper.sha256 = sha256(original); }
});
await check('unrecorded-consumer-rejected', async () => {
    const filename = path.join(outputRoot, 'Extra.kt'), bytes = Buffer.from('package probe\nfun extra(substitutor: org.jetbrains.kotlin.types.TypeSubstitutor) = substitutor.isEmpty\n');
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); retained.push({ path: 'probe/Extra.kt', filename, bytes: bytes.length, sha256: sha256(bytes) });
    try { await assert.rejects(final, /Unrecorded or missing selected getter calls/); } finally { retained.pop(); }
});
await check('comments-literals-and-real-method-calls-excluded', async () => assert.deepEqual(calls(Buffer.from('// substitutor.isEmpty\nval text = "capturingSubstitutor.isEmpty"\nsubstitutor.isEmpty()\n')), []));
await check('bound-predecessor-receipt-tampering-rejected', async () => {
    const filename = prepared.receipt.bindings[0].receiptPath, original = await readRegular(filename); await writeFile(filename, Buffer.concat([original, Buffer.from(' ')]));
    try { await assert.rejects(final, /Dependency receipt changed/); } finally { await writeFile(filename, original); }
});
const lock = JSON.parse(await readRegular(fileURLToPath(new URL('./sources.lock.json', import.meta.url))));
for (const item of retained.filter(item => lock.selected.some(pin => pin.path === item.path) || item.path === OUTPUT)) {
    const bytes = assembleImports(await readRegular(item.filename), fixture.recordedPropertyImports); await writeFile(item.filename, bytes); item.bytes = bytes.length; item.sha256 = sha256(bytes);
}
await check('actual-filtered-global-imports-and-full-inventory-final', async () => assert.equal((await final()).selectedSources, fixture.retainedSources.length + 1));
await check('missing-helper-rejected', async () => { retained.pop(); try { await assert.rejects(final, /Missing typed getter output/); } finally { retained.push(helper); } });
await check('unrelated-legitimate-source-addition-allowed', async () => {
    const filename = path.join(outputRoot, 'Unrelated.kt'), bytes = Buffer.from('package probe\nval ordinary = 1\n'); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    retained.push({ path: 'probe/Unrelated.kt', filename, bytes: bytes.length, sha256: sha256(bytes) }); try { await final(); } finally { retained.pop(); }
});
const receipt = { result: 'pass', checks, historical: fixture.historical, preparedSources: fixture.retainedSources.length,
    finalSources: retained.length, final: await final(), outputRoot, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(path.join(outputRoot, 'receipt.json'), receipt); console.log(JSON.stringify({ result: 'pass', checks: checks.length, sources: retained.length }));
