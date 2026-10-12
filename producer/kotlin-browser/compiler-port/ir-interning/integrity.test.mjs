import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { sha256 } from '../../scripts/source.mjs';
import { TARGET, INTERNING_SET, RECIPE, transformIrInterning } from './transform.mjs';
import { prepareIrInterning, verifyIrInterning, verifyFinalIrInterning } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
assert.equal(process.argv.length, 3, 'Usage: integrity.test.mjs NEW_OUTPUT_ROOT');
const root = path.resolve(process.argv[2]); assert(root.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(root, { mode: 0o700 });
const build = path.join(REPO, 'out/kotlin-compiler-port/builds/receiver-predicate-whole-1791715136452421425');
const evidence = JSON.parse(await readFile(path.join(HERE, '../evidence/receiver-predicate-build-failure.json')));
const previousBytes = await readFile(path.join(build, 'compiler-build-receipt.json'));
assert.equal(sha256(previousBytes), evidence.sourceBuildReceipt.sha256);
const previous = JSON.parse(previousBytes), argumentBytes = await readFile(path.join(build, 'compiler-klib.args'));
assert.equal(sha256(argumentBytes), previous.commands[0].argumentFileSha256);
const sourceArgs = argumentBytes.toString().split('\n')
    .filter(line => line.startsWith('"/') && line.endsWith('.kt"')).map(line => JSON.parse(line));
assert.equal(sourceArgs.length, previous.compileSources.length); assert.equal(previous.compileSources.length, 3533);
const originalRows = previous.compileSources.map((row, index) => ({ ...row, filename: sourceArgs[index] }));
for (const row of originalRows) assert(row.filename.endsWith('/' + row.path));
assert.equal(previous.status, 'failed'); assert.equal(previous.commands.length, 1); assert.equal(previous.commands[0].exitCode, 1);
for (let offset = 0; offset < originalRows.length; offset += 24) {
    const results = await Promise.allSettled(originalRows.slice(offset, offset + 24).map(async row => {
        const bytes = await readFile(row.filename); assert.equal(bytes.length, row.bytes); assert.equal(sha256(bytes), row.sha256);
    }));
    for (const result of results) if (result.status !== 'fulfilled') throw result.reason;
}
const inputs = [];
for (const name of ['integrity.test.mjs', 'prepare.mjs', 'transform.mjs', 'sources.lock.json']) {
    const bytes = await readFile(path.join(HERE, name)); inputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
}
const complete = [];


async function fixture(name) {
    const prepared = await prepareIrInterning({ sourceRoot, outputRoot: path.join(root, name) });
    const options = { sourceRoot, outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256 };
    const rows = originalRows.filter(row => row.path !== TARGET).map(row => ({ ...row }));
    for (const filename of prepared.commonSources) { const bytes = await readFile(filename); rows.push({ path: path.relative(prepared.outputRoot, filename), filename, bytes: bytes.length, sha256: sha256(bytes) }); }
    assert.equal(rows.length, 3534);
    return { prepared, options, rows, final: () => verifyFinalIrInterning({ ...options, retainedSources: rows }) };
}
test('three exact imports retain every other genuine full-source byte', async () => {
    const original = await readFile(path.join(sourceRoot, TARGET)), common = transformIrInterning(original); let restored = common.toString();
    for (const [before, after, count] of [...RECIPE].reverse()) { assert.equal(restored.split(after).length - 1, count); restored = restored.split(after).join(before); }
    assert.deepEqual(Buffer.from(restored), original); assert.throws(() => transformIrInterning(common));
    assert.throws(() => transformIrInterning(Buffer.concat([original, Buffer.from(RECIPE[0][0])])));
    complete.push('roundtrip');
});
test('actual 3533-source graph selects complete canonical port and one helper', async () => {
    const f = await fixture('positive'); await verifyIrInterning(f.options); const final = await f.final();
    assert.equal(final.checked.length, 2); assert.equal(final.exactBodyAndOwnerVerified, true); assert.equal(final.fullCompilerBuilt, false);
    assert.deepEqual(f.rows.filter(row => row.path !== TARGET && row.path !== INTERNING_SET), originalRows.filter(row => row.path !== TARGET));
    complete.push('positive');
});
test('final body changes reject even after rehashing actual row', async () => {
    const f = await fixture('body'), row = f.rows.find(row => row.path === TARGET), before = await readFile(row.filename);
    const forged = Buffer.from(before.toString().replace('return fileEntries.addOrGet(file)', 'return file'));
    assert.notDeepEqual(forged, before); await writeFile(row.filename, forged); row.bytes = forged.length; row.sha256 = sha256(forged);
    await assert.rejects(f.final()); await writeFile(row.filename, before); row.bytes = before.length; row.sha256 = sha256(before); await f.final();
    complete.push('body');
});
test('full snapshot and external receipt digest prevent provenance reauthoring', async () => {
    const f = await fixture('receipt'), bytes = await readFile(f.prepared.receiptPath), receipt = JSON.parse(bytes); receipt.fullCompilerBuilt = true;
    await writeFile(f.prepared.receiptPath, JSON.stringify(receipt)); await assert.rejects(f.final(), /receipt digest changed/);
    await assert.rejects(verifyIrInterning({ ...f.options, expectedReceiptSha256: sha256(Buffer.from(JSON.stringify(receipt))) }), /receipt changed/);
    await writeFile(f.prepared.receiptPath, bytes); const reference = path.join(f.prepared.outputRoot, 'reference-original', TARGET), original = await readFile(reference);
    await writeFile(reference, Buffer.concat([original, Buffer.from('\n')])); await assert.rejects(f.final(), /snapshot changed/);
    await writeFile(reference, original); await f.final();
    complete.push('receipt');
});
test('missing, duplicate or switched source owners reject', async () => {
    const f = await fixture('owners'), row = f.rows.find(row => row.path === INTERNING_SET);
    await assert.rejects(verifyFinalIrInterning({ ...f.options, retainedSources: f.rows.filter(item => item !== row) }), /Missing interning final source/);
    await assert.rejects(verifyFinalIrInterning({ ...f.options, retainedSources: [...f.rows, { ...row }] }), /Duplicate interning final logical path/);
    await assert.rejects(verifyFinalIrInterning({ ...f.options, retainedSources: [...f.rows, { ...row, path: 'copy/Multimap.kt' }] }), /Duplicate interning final owner/);
    const copy = path.join(root, 'identical-copy.kt'); await copyFile(row.filename, copy);
    await assert.rejects(verifyFinalIrInterning({ ...f.options, retainedSources: f.rows.map(item => item === row ? { ...row, filename: copy } : item) }), /Wrong interning final owner/);
    await f.final();
    complete.push('owners');
});
test('exact recorded imports normalize while arbitrary or duplicate imports reject', async () => {
    const f = await fixture('imports'), imports = previous.propertyImports.imports;
    for (const row of f.rows.filter(row => row.path === TARGET || row.path === INTERNING_SET)) {
        const original = await readFile(row.filename), text = original.toString(), pkg = /^package[^\r\n]+/m.exec(text), end = pkg.index + pkg[0].length;
        const existing = new Set([...text.matchAll(/^import ([^\r\n]+)$/gm)].map(match => match[1]));
        const marker = '\n' + imports.filter(name => !existing.has(name)).map(name => 'import ' + name).join('\n') + '\n';
        const changed = Buffer.from(text.slice(0, end) + marker + text.slice(end)); await writeFile(row.filename, changed); row.bytes = changed.length; row.sha256 = sha256(changed);
        await assert.rejects(f.final());
        const duplicate = Buffer.from(text.slice(0, end) + marker + marker + text.slice(end)); await writeFile(row.filename, duplicate); row.bytes = duplicate.length; row.sha256 = sha256(duplicate);
        await assert.rejects(verifyFinalIrInterning({ ...f.options, retainedSources: f.rows, recordedPropertyImports: imports }));
        await writeFile(row.filename, changed); row.bytes = changed.length; row.sha256 = sha256(changed);
    }
    await verifyFinalIrInterning({ ...f.options, retainedSources: f.rows, recordedPropertyImports: imports });
    complete.push('imports');
});
test('reused and overlapping output roots cannot overwrite genuine inputs', async () => {
    const f = await fixture('reuse'); await assert.rejects(prepareIrInterning({ sourceRoot, outputRoot: f.prepared.outputRoot }));
    await assert.rejects(prepareIrInterning({ sourceRoot, outputRoot: sourceRoot }));
    await assert.rejects(prepareIrInterning({ sourceRoot, outputRoot: path.join(sourceRoot, 'nested') }));
    complete.push('reuse');
});

test('original service and pinned production callers reject cache tampering', async () => {
    const lock = JSON.parse(await readFile(path.join(HERE, 'sources.lock.json'))), copyRoot = path.join(root, 'private-source');
    for (const pin of [lock.original, ...lock.callerAndDependencySources]) {
        const name = path.join(copyRoot, pin.path); await mkdir(path.dirname(name), { recursive: true });
        await copyFile(path.join(sourceRoot, pin.path), name);
    }
    for (const [index, pin] of [lock.original, lock.callerAndDependencySources[0]].entries()) {
        const name = path.join(copyRoot, pin.path), bytes = await readFile(name);
        await writeFile(name, Buffer.concat([bytes, Buffer.from('\n')]));
        await assert.rejects(prepareIrInterning({ sourceRoot: copyRoot, outputRoot: path.join(root, 'cache-tamper-' + index) }));
        await writeFile(name, bytes);
    }
    const prepared = await prepareIrInterning({ sourceRoot: copyRoot, outputRoot: path.join(root, 'cache-restored') });
    await verifyIrInterning({ sourceRoot: copyRoot, outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256 });
    complete.push('source-and-caller-cache');
});

after(async () => {
    if (complete.length !== 8) return;
    for (const pin of inputs) { const bytes = await readFile(path.join(HERE, pin.path)); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); }
    await writeFile(path.join(root, 'receipt.json'), JSON.stringify({ schemaVersion: 1, kind: 'genuine-ir-interning-integrity', result: 'pass',
        historical: { build: path.relative(REPO, build), receiptSha256: sha256(previousBytes), argumentFileSha256: sha256(argumentBytes), selectedSources: originalRows.length },
        complete, originalInventory: originalRows, inputs, fullCompilerBuilt: false, languageReadiness: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
});
