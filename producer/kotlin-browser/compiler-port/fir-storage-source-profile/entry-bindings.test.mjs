import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyFirStorageEntryBindings } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('checked-in browser entries satisfy the profile before compiler preparation', async () => {
    const entries = await verifyFirStorageEntryBindings();
    assert.deepEqual([...entries.keys()], ['compiler-port-entry/BrowserCompiler.kt', 'compiler-port-entry/BrowserCompilerPipeline.kt']);
});

test('entry preflight rejects stale size and same-size body drift with the affected path', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kotlin-entry-bindings-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const name of ['BrowserCompiler.kt', 'BrowserCompilerPipeline.kt']) {
        await writeFile(path.join(root, name), await readFile(path.join(here, '../entry', name)));
    }
    await verifyFirStorageEntryBindings(root);
    const filename = path.join(root, 'BrowserCompilerPipeline.kt'), original = await readFile(filename);
    await writeFile(filename, Buffer.concat([original, Buffer.from('\n')]));
    await assert.rejects(verifyFirStorageEntryBindings(root), /FIR storage entry binding changed: compiler-port-entry\/BrowserCompilerPipeline\.kt;.*\(bytes\)/);
    const changed = Buffer.from(original);
    const offset = changed.indexOf('maximumArtifactBytes');
    assert(offset >= 0);
    changed[offset] = 'n'.charCodeAt(0);
    await writeFile(filename, changed);
    await assert.rejects(verifyFirStorageEntryBindings(root), /FIR storage entry binding changed: compiler-port-entry\/BrowserCompilerPipeline\.kt;.*\(sha256\)/);
    await writeFile(filename, original);
    await verifyFirStorageEntryBindings(root);
    await rm(filename);
    await assert.rejects(verifyFirStorageEntryBindings(root), { code: 'ENOENT' });
});
