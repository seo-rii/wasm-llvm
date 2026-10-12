import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { assembleImports } from '../type-substitutor-getter/prepare.mjs';
import { TARGETS, HELPER, RECIPE, transformLoweringPhaseSource } from './transform.mjs';
import { prepareLoweringPhaseFactories, verifyLoweringPhaseFactories, verifyFinalLoweringPhaseFactories } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
assert.equal(process.argv.length, 3, 'Usage: integrity.test.mjs NEW_OUTPUT_ROOT');
const root = path.resolve(process.argv[2]); assert(root.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(root, { mode: 0o700 });
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const build = path.join(REPO, 'out/kotlin-compiler-port/builds/property-metadata-whole-1791764871402591253');
const evidence = JSON.parse(await readRegular(path.join(HERE, '../evidence/property-metadata-build-failure.json')));
const receiptBytes = await readRegular(path.join(build, 'compiler-build-receipt.json'), 64 * 1024 * 1024);
assert.equal(sha256(receiptBytes), evidence.sourceBuildReceipt.sha256);
const previous = JSON.parse(receiptBytes), argumentBytes = await readRegular(path.join(build, 'compiler-klib.args'));
assert.equal(previous.status, 'failed'); assert.equal(previous.commands.length, 1); assert.equal(previous.commands[0].exitCode, 1);
assert.equal(sha256(argumentBytes), previous.commands[0].argumentFileSha256);
const args = argumentBytes.toString().trimEnd().split('\n').map(JSON.parse), filenames = args.slice(-previous.compileSources.length);
assert.equal(filenames.length, 3540); assert(filenames.every(name => path.isAbsolute(name) && name.endsWith('.kt')));
const originalRows = previous.compileSources.map((row, i) => ({ ...row, filename: filenames[i] }));
for (let n = 0; n < originalRows.length; n += 24) {
    const settled = await Promise.allSettled(originalRows.slice(n, n + 24).map(async row => {
        const bytes = await readRegular(row.filename); assert.equal(bytes.length, row.bytes); assert.equal(sha256(bytes), row.sha256);
    }));
    for (const r of settled) if (r.status !== 'fulfilled') throw r.reason;
}
const inputs = [];
for (const name of ['integrity.test.mjs', 'prepare.mjs', 'transform.mjs', 'sources.lock.json']) {
    const bytes = await readRegular(path.join(HERE, name)); inputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
}
const passed = [];
async function fixture(name) {
    const prepared = await prepareLoweringPhaseFactories({ sourceRoot, outputRoot: path.join(root, name) });
    const options = { sourceRoot, outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256 };
    const replacements = [];
    for (const filename of prepared.commonSources) { const bytes = await readRegular(filename); replacements.push({ path: path.relative(prepared.outputRoot, filename), filename, bytes: bytes.length, sha256: sha256(bytes) }); }
    const byPath = new Map(replacements.map(row => [row.path, row]));
    const rows = [...originalRows.map(row => byPath.get(row.path) ?? { ...row }), byPath.get(HELPER)];
    return { prepared, options, rows, replacements, replacement: replacements[0], final: () => verifyFinalLoweringPhaseFactories({ ...options, retainedSources: rows }) };
}
test('exact full factory and four caller recipes retain all other bytes', async () => {
    for (const logical of TARGETS) {
        const original = await readRegular(path.join(sourceRoot, logical)), common = transformLoweringPhaseSource(logical, original); let restored = common.toString();
        for (const [before, after, count] of [...RECIPE[logical]].reverse()) {
            assert.equal(restored.split(after).length - 1, count); restored = restored.split(after).join(before);
        }
        assert.deepEqual(Buffer.from(restored), original); assert.throws(() => transformLoweringPhaseSource(logical, common));
    }
    passed.push('five-full-source-roundtrips');
});
test('actual whole graph preserves every other owner and order', async () => {
    const f = await fixture('positive'); await verifyLoweringPhaseFactories(f.options); const final = await f.final();
    assert.equal(final.checked.length, 6); assert.equal(final.fullCompilerBuilt, false); assert.equal(f.rows.length, originalRows.length + 1);
    assert.deepEqual(f.rows.filter(row => !TARGETS.includes(row.path) && row.path !== HELPER), originalRows.filter(row => !TARGETS.includes(row.path))); passed.push('actual-3540-source-positive');
});
test('rehashing modified algorithm does not authorize it', async () => {
    const f = await fixture('body'), row = f.replacement, before = await readRegular(row.filename);
    const forged = Buffer.from(before.toString().replace('return input', 'return error("forged")')); assert(!forged.equals(before));
    await writeFile(row.filename, forged); row.bytes = forged.length; row.sha256 = sha256(forged); await assert.rejects(f.final());
    await writeFile(row.filename, before); row.bytes = before.length; row.sha256 = sha256(before); await f.final(); passed.push('rehashed-algorithm-negative-restored');
});
test('caller declared-class and helper forwarding forgery reject after rehashing', async () => {
    const f = await fixture('metadata-forwarding');
    for (const [row, from, to] of [
        [f.replacements.find(row => row.path.endsWith('/CommonLoweringPhases.kt')), 'loweringFactory(FunctionInlining::class, ::createInlineAllFunctionsPhase)', 'loweringFactory(ModuleLoweringPass::class, ::createInlineAllFunctionsPhase)'],
        [f.replacements.find(row => row.path === HELPER), 'createLoweringPass(context)', 'error("forged forwarding")'],
    ]) {
        const before = await readRegular(row.filename), forged = Buffer.from(before.toString().replace(from, to)); assert(!forged.equals(before));
        await writeFile(row.filename, forged); row.bytes = forged.length; row.sha256 = sha256(forged); await assert.rejects(f.final());
        await writeFile(row.filename, before); row.bytes = before.length; row.sha256 = sha256(before); await f.final();
    }
    passed.push('declared-class-helper-negatives-restored');
});
test('genuine declared pass class cache cannot be silently replaced', async () => {
    const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json'))), copied = path.join(root, 'private-source');
    for (const pin of [...lock.originals, ...lock.declarationFiles]) {
        const filename = path.join(copied, pin.path); await mkdir(path.dirname(filename), { recursive: true }); await copyFile(path.join(sourceRoot, pin.path), filename);
    }
    const pin = lock.declarationFiles[0], filename = path.join(copied, pin.path), before = await readRegular(filename);
    await writeFile(filename, Buffer.concat([before, Buffer.from('\n')]));
    await assert.rejects(prepareLoweringPhaseFactories({ sourceRoot: copied, outputRoot: path.join(root, 'forged-class-cache') }));
    await writeFile(filename, before);
    const restored = await prepareLoweringPhaseFactories({ sourceRoot: copied, outputRoot: path.join(root, 'restored-class-cache') });
    await verifyLoweringPhaseFactories({ sourceRoot: copied, outputRoot: restored.outputRoot, expectedReceiptSha256: restored.receiptSha256 });
    passed.push('declared-class-cache-negative-restored');
});
test('external receipt and snapshot pins reject reauthoring', async () => {
    const f = await fixture('receipt'), bytes = await readRegular(f.prepared.receiptPath), receipt = JSON.parse(bytes); receipt.fullCompilerBuilt = true;
    const forged = Buffer.from(JSON.stringify(receipt)); await writeFile(f.prepared.receiptPath, forged); await assert.rejects(f.final(), /receipt digest changed/);
    await assert.rejects(verifyLoweringPhaseFactories({ ...f.options, expectedReceiptSha256: sha256(forged) }), /receipt changed/);
    await writeFile(f.prepared.receiptPath, bytes); const reference = path.join(f.prepared.outputRoot, 'reference-original', TARGETS[0]), original = await readRegular(reference);
    await writeFile(reference, Buffer.concat([original, Buffer.from('\n')])); await assert.rejects(f.final(), /snapshot changed/);
    await writeFile(reference, original); await f.final(); passed.push('receipt-snapshot-negatives-restored');
});
test('missing, duplicate and relocated owners reject', async () => {
    const f = await fixture('owner'), row = f.replacement;
    await assert.rejects(verifyFinalLoweringPhaseFactories({ ...f.options, retainedSources: f.rows.filter(item => item !== row) }), /Missing phase/);
    await assert.rejects(verifyFinalLoweringPhaseFactories({ ...f.options, retainedSources: [...f.rows, { ...row }] }), /Duplicate phase final logical/);
    await assert.rejects(verifyFinalLoweringPhaseFactories({ ...f.options, retainedSources: [...f.rows, { ...row, path: 'copy/Phase.kt' }] }), /Duplicate phase final owner/);
    const copy = path.join(root, 'copy.kt'); await copyFile(row.filename, copy);
    await assert.rejects(verifyFinalLoweringPhaseFactories({ ...f.options, retainedSources: f.rows.map(item => item === row ? { ...row, filename: copy } : item) }), /Wrong phase/);
    await f.final(); passed.push('owner-negatives-restored');
});
test('recorded assembly imports pass; arbitrary and duplicates reject', async () => {
    const f = await fixture('imports'), row = f.replacement, original = await readRegular(row.filename), imports = previous.propertyImports.imports;
    const assembled = assembleImports(original, imports), pkg = /^package[^\r\n]+/m.exec(assembled.toString()), end = pkg.index + pkg[0].length;
    for (const bytes of [Buffer.from(assembled.toString().slice(0, end) + '\nimport org.example.forged\n' + assembled.toString().slice(end))]) {
        await writeFile(row.filename, bytes); row.bytes = bytes.length; row.sha256 = sha256(bytes);
        await assert.rejects(verifyFinalLoweringPhaseFactories({ ...f.options, retainedSources: f.rows, recordedPropertyImports: imports }));
    }
    const text = assembled.toString(), marker = '\n' + imports.map(name => 'import ' + name).join('\n') + '\n';
    const duplicate = Buffer.from(text.slice(0, end) + marker + text.slice(end));
    await writeFile(row.filename, duplicate); row.bytes = duplicate.length; row.sha256 = sha256(duplicate);
    await assert.rejects(verifyFinalLoweringPhaseFactories({ ...f.options, retainedSources: f.rows, recordedPropertyImports: imports }));
    await writeFile(row.filename, assembled); row.bytes = assembled.length; row.sha256 = sha256(assembled);
    await assert.rejects(f.final()); await verifyFinalLoweringPhaseFactories({ ...f.options, retainedSources: f.rows, recordedPropertyImports: imports });
    await writeFile(row.filename, original); row.bytes = original.length; row.sha256 = sha256(original); await f.final(); passed.push('assembly-negatives-restored');
});
test('reused and overlapping outputs cannot overwrite originals', async () => {
    const f = await fixture('reuse'); await assert.rejects(prepareLoweringPhaseFactories({ sourceRoot, outputRoot: f.prepared.outputRoot }));
    await assert.rejects(prepareLoweringPhaseFactories({ sourceRoot, outputRoot: sourceRoot }));
    await assert.rejects(prepareLoweringPhaseFactories({ sourceRoot, outputRoot: path.join(sourceRoot, 'nested') })); await f.final(); passed.push('root-negatives-restored');
});
after(async () => {
    if (passed.length !== 9) return;
    for (const pin of inputs) { const bytes = await readRegular(path.join(HERE, pin.path)); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); }
    await writeJson(path.join(root, 'receipt.json'), { schemaVersion: 1, kind: 'genuine-lowering-phase-factories-integrity', result: 'pass',
        historical: { build: path.relative(REPO, build), receiptSha256: sha256(receiptBytes), argumentFileSha256: sha256(argumentBytes), selectedSources: originalRows.length },
        passed, originalInventory: originalRows, inputs, fullCompilerBuilt: false, languageReadiness: false });
});
