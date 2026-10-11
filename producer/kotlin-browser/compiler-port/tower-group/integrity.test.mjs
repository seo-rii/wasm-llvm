import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { sha256 } from '../../scripts/source.mjs';
import { TARGET, NUMBERS, RECIPE, transformTowerGroup } from './transform.mjs';
import { prepareTowerGroup, verifyTowerGroup, verifyFinalTowerGroup } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const root = await mkdtemp(path.join(REPO, 'out/kotlin-tower-group-guards-')); after(async () => rm(root, { recursive: true, force: true }));
const build = path.join(REPO, 'out/kotlin-compiler-port/builds/memory-host-whole-1791700702126849235');
const evidence = JSON.parse(await readFile(path.join(HERE, '../evidence/memory-host-build-failure.json')));
const previousBytes = await readFile(path.join(build, 'compiler-build-receipt.json'));
assert.equal(sha256(previousBytes), evidence.sourceBuildReceipt.sha256);
const previous = JSON.parse(previousBytes), argumentBytes = await readFile(path.join(build, 'compiler-klib.args'));
assert.equal(sha256(argumentBytes), previous.commands[0].argumentFileSha256);
const sourceArgs = argumentBytes.toString().split('\n')
    .filter(line => line.startsWith('"/') && line.endsWith('.kt"')).map(line => JSON.parse(line));
assert.equal(sourceArgs.length, previous.compileSources.length); assert.equal(previous.compileSources.length, 3524);
const originalRows = previous.compileSources.map((row, index) => ({ ...row, filename: sourceArgs[index] }));
for (const row of originalRows) assert(row.filename.endsWith('/' + row.path));

async function fixture(name) {
    const prepared = await prepareTowerGroup({ sourceRoot, outputRoot: path.join(root, name) });
    const options = { sourceRoot, outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256 };
    const rows = originalRows.filter(row => row.path !== TARGET).map(row => ({ ...row }));
    for (const filename of prepared.commonSources) { const bytes = await readFile(filename); rows.push({ path: path.relative(prepared.outputRoot, filename), filename, bytes: bytes.length, sha256: sha256(bytes) }); }
    assert.equal(rows.length, 3525);
    return { prepared, options, rows, final: () => verifyFinalTowerGroup({ ...options, retainedSources: rows }) };
}
test('nine exact spans retain every other genuine full-source byte', async () => {
    const original = await readFile(path.join(sourceRoot, TARGET)), common = transformTowerGroup(original); let restored = common.toString();
    for (const [before, after, count] of [...RECIPE].reverse()) { assert.equal(restored.split(after).length - 1, count); restored = restored.split(after).join(before); }
    assert.deepEqual(Buffer.from(restored), original); assert.throws(() => transformTowerGroup(common));
    assert.throws(() => transformTowerGroup(Buffer.concat([original, Buffer.from(RECIPE[0][0])])));
});
test('actual 3524-source graph selects complete canonical port and one helper', async () => {
    const f = await fixture('positive'); await verifyTowerGroup(f.options); const final = await f.final();
    assert.equal(final.checked.length, 2); assert.equal(final.exactBodyAndOwnerVerified, true); assert.equal(final.fullCompilerBuilt, false);
    assert.deepEqual(f.rows.filter(row => row.path !== TARGET && row.path !== NUMBERS), originalRows.filter(row => row.path !== TARGET));
});
test('final body changes reject even after rehashing actual row', async () => {
    const f = await fixture('body'), row = f.rows.find(row => row.path === TARGET), before = await readFile(row.filename);
    const forged = Buffer.from(before.toString().replace('return@run compareUnsigned(code, other.code)', 'return@run 0'));
    assert.notDeepEqual(forged, before); await writeFile(row.filename, forged); row.bytes = forged.length; row.sha256 = sha256(forged);
    await assert.rejects(f.final()); await writeFile(row.filename, before); row.bytes = before.length; row.sha256 = sha256(before); await f.final();
});
test('full snapshot and external receipt digest prevent provenance reauthoring', async () => {
    const f = await fixture('receipt'), bytes = await readFile(f.prepared.receiptPath), receipt = JSON.parse(bytes); receipt.fullCompilerBuilt = true;
    await writeFile(f.prepared.receiptPath, JSON.stringify(receipt)); await assert.rejects(f.final(), /receipt digest changed/);
    await assert.rejects(verifyTowerGroup({ ...f.options, expectedReceiptSha256: sha256(Buffer.from(JSON.stringify(receipt))) }), /receipt changed/);
    await writeFile(f.prepared.receiptPath, bytes); const reference = path.join(f.prepared.outputRoot, 'reference-original', TARGET), original = await readFile(reference);
    await writeFile(reference, Buffer.concat([original, Buffer.from('\n')])); await assert.rejects(f.final(), /snapshot changed/);
    await writeFile(reference, original); await f.final();
});
test('missing, duplicate or switched source owners reject', async () => {
    const f = await fixture('owners'), row = f.rows.find(row => row.path === NUMBERS);
    await assert.rejects(verifyFinalTowerGroup({ ...f.options, retainedSources: f.rows.filter(item => item !== row) }), /Missing tower final source/);
    await assert.rejects(verifyFinalTowerGroup({ ...f.options, retainedSources: [...f.rows, { ...row }] }), /Duplicate tower final logical path/);
    await assert.rejects(verifyFinalTowerGroup({ ...f.options, retainedSources: [...f.rows, { ...row, path: 'copy/Numbers.kt' }] }), /Duplicate tower final owner/);
    const copy = path.join(root, 'identical-copy.kt'); await copyFile(row.filename, copy);
    await assert.rejects(verifyFinalTowerGroup({ ...f.options, retainedSources: f.rows.map(item => item === row ? { ...row, filename: copy } : item) }), /Wrong tower final owner/);
    await f.final();
});
test('exact recorded imports normalize while arbitrary or duplicate imports reject', async () => {
    const f = await fixture('imports'), imports = previous.propertyImports.imports;
    for (const row of f.rows.filter(row => row.path === TARGET || row.path === NUMBERS)) {
        const original = await readFile(row.filename), text = original.toString(), pkg = /^package[^\r\n]+/m.exec(text), end = pkg.index + pkg[0].length;
        const existing = new Set([...text.matchAll(/^import ([^\r\n]+)$/gm)].map(match => match[1]));
        const marker = '\n' + imports.filter(name => !existing.has(name)).map(name => 'import ' + name).join('\n') + '\n';
        const changed = Buffer.from(text.slice(0, end) + marker + text.slice(end)); await writeFile(row.filename, changed); row.bytes = changed.length; row.sha256 = sha256(changed);
        await assert.rejects(f.final());
        const duplicate = Buffer.from(text.slice(0, end) + marker + marker + text.slice(end)); await writeFile(row.filename, duplicate); row.bytes = duplicate.length; row.sha256 = sha256(duplicate);
        await assert.rejects(verifyFinalTowerGroup({ ...f.options, retainedSources: f.rows, recordedPropertyImports: imports }));
        await writeFile(row.filename, changed); row.bytes = changed.length; row.sha256 = sha256(changed);
    }
    await verifyFinalTowerGroup({ ...f.options, retainedSources: f.rows, recordedPropertyImports: imports });
});
test('reused and overlapping output roots cannot overwrite genuine inputs', async () => {
    const f = await fixture('reuse'); await assert.rejects(prepareTowerGroup({ sourceRoot, outputRoot: f.prepared.outputRoot }));
    await assert.rejects(prepareTowerGroup({ sourceRoot, outputRoot: sourceRoot }));
    await assert.rejects(prepareTowerGroup({ sourceRoot, outputRoot: path.join(sourceRoot, 'nested') }));
});
