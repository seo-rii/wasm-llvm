import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { prepareDescriptorBaseImplementations, verifyDescriptorBaseImplementations, verifyFinalDescriptorBaseImplementations } from './prepare.mjs';
import { descriptorBaseFixture } from './fixture.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const root = path.resolve(process.env.DESCRIPTOR_BASE_GUARDS);
assert(root.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(root, { mode: 0o700 });
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const prepared = await prepareDescriptorBaseImplementations({ sourceRoot, outputRoot: path.join(root, 'prepared'), ...await descriptorBaseFixture() });
const selected = prepared.receipt.files.map(pin => ({ path: pin.path, filename: path.join(prepared.outputRoot, pin.path), bytes: pin.bytes, sha256: pin.sha256 }));
const final = (rows = selected, imports = []) => verifyFinalDescriptorBaseImplementations({ outputRoot: prepared.outputRoot, retainedSources: rows, recordedPropertyImports: imports });
async function mutate(filename, bytes, action) { const previous = await readRegular(filename); try { await writeFile(filename, bytes); await action(); } finally { await writeFile(filename, previous); } }
test('full preparation replay and exact predecessor removal', async () => {
    assert.deepEqual(await verifyDescriptorBaseImplementations(prepared.outputRoot), prepared.receipt);
    const proof = await final(); assert.equal(proof.receipt.checked.length, 3); assert.deepEqual(proof.predecessorRetainedSources, (await descriptorBaseFixture()).retainedSources);
});
test('missing and duplicate output selections are rejected with their reason', async () => {
    await assert.rejects(final(selected.slice(1)), /Missing descriptor base final source/);
    await assert.rejects(final([...selected, selected[0]]), /Duplicate descriptor base selection path/);
});
test('output owner and claimed byte hash are checked', async () => {
    await assert.rejects(final(selected.map((row, index) => index ? row : { ...row, filename: path.join(root, 'copied.kt') })), /Wrong descriptor base source owner/);
    await assert.rejects(final(selected.map((row, index) => index ? row : { ...row, sha256: '0'.repeat(64) })), /Descriptor base final hash mismatch/);
});
test('reintroduced Java input is rejected', async () => {
    const pin = prepared.receipt.originals.find(pin => pin.path.endsWith('/VariableDescriptorImpl.java'));
    await assert.rejects(final([...selected, { path: pin.path, filename: path.join(prepared.outputRoot, 'reference', pin.path), bytes: pin.bytes, sha256: pin.sha256 }]), /Java descriptor base was reintroduced/);
});
test('changed original evidence cannot pass replay', async () => {
    const pin = prepared.receipt.originals.find(pin => pin.path.endsWith('/VariableDescriptorImpl.java')), filename = path.join(prepared.outputRoot, 'reference', pin.path);
    const before = await readRegular(filename);
    await mutate(filename, Buffer.concat([before, Buffer.from('\n')]), async () => {
        await assert.rejects(verifyDescriptorBaseImplementations(prepared.outputRoot), /Pinned source content mismatch: .*VariableDescriptorImpl.java/);
    });
});
test('shipping body drift is rejected even after honest selection rehash', async () => {
    const row = selected[0], before = await readRegular(row.filename), changed = Buffer.from(before.toString().replace('= emptyList()', '= listOf()'));
    assert.notEqual(sha256(changed), sha256(before));
    await mutate(row.filename, changed, async () => {
        const rows = [{ ...row, bytes: changed.length, sha256: sha256(changed) }, ...selected.slice(1)];
        await assert.rejects(final(rows), /Pinned source content mismatch: compiler-port-descriptor-bases\/DescriptorBaseImplementations.kt/);
    });
});
test('only exact recorded prefix import blocks are admitted', async () => {
    const row = selected[0], before = await readRegular(row.filename), imports = ['org.jetbrains.kotlin.portable.descriptors.*'];
    const changed = Buffer.from(before.toString().replace(/(^package[^\n]*)/m, '$1\n' + imports.map(name => 'import ' + name).join('\n') + '\n'));
    await mutate(row.filename, changed, async () => {
        const rows = [{ ...row, bytes: changed.length, sha256: sha256(changed) }, ...selected.slice(1)];
        assert.equal((await final(rows, imports)).receipt.checked.length, 3);
        await assert.rejects(final(rows), /Pinned source content mismatch: compiler-port-descriptor-bases\/DescriptorBaseImplementations.kt/);
    });
});
test('receipt claims are reconstructed and restored positive remains valid', async () => {
    const filename = path.join(prepared.outputRoot, 'receipt.json');
    await mutate(filename, Buffer.from(JSON.stringify({ ...prepared.receipt, fullCompilerBuilt: true })), async () => {
        await assert.rejects(final(), /Descriptor base preparation receipt changed/);
    });
    assert.equal((await final()).receipt.checked.length, 3);
});

test('wrong visitor predecessor ownership fails before publication', async () => {
    const fixture = await descriptorBaseFixture();
    await assert.rejects(prepareDescriptorBaseImplementations({ sourceRoot, outputRoot: path.join(root, 'wrong-predecessor'), ...fixture,
        retainedSources: fixture.retainedSources.map(row => ({ ...row, filename: path.join(root, 'alien.kt') })) }), /Wrong value parameter predecessor owner/);
});
test('duplicate visitor predecessor selection fails before publication', async () => {
    const fixture = await descriptorBaseFixture();
    await assert.rejects(prepareDescriptorBaseImplementations({ sourceRoot, outputRoot: path.join(root, 'duplicate-predecessor'), ...fixture,
        retainedSources: [...fixture.retainedSources, ...fixture.retainedSources] }), /Value parameter predecessor selection must be unique/);
});
