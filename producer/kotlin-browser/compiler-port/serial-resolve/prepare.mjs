#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);

export async function prepareSerialResolveSources({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep));
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json'));
    const lock = JSON.parse(lockBytes);
    assert.equal(lock.kind, 'official-fir-lazy-resolve-serial-host');
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    const pin = lock.sourceFile;
    relativePath(pin.path);
    const original = verifyFile(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), pin);
    const patchFile = path.join(here, relativePath(lock.patch.path));
    const patch = await readRegular(patchFile, lock.patch.bytes);
    assert.equal(patch.length, lock.patch.bytes); assert.equal(sha256(patch), lock.patch.sha256);
    const adapter = await readRegular(path.join(here, relativePath(lock.adapter.path)), lock.adapter.bytes);
    assert.equal(adapter.length, lock.adapter.bytes); assert.equal(sha256(adapter), lock.adapter.sha256);
    const destination = path.join(outputRoot, pin.path);
    await assertNoSymlink(destination);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, original, { flag: 'wx', mode: 0o600 });
    const commands = [];
    for (const args of [['apply', '--check', patchFile], ['apply', patchFile], ['apply', '--reverse', '--check', patchFile]]) {
        await execute('git', args, { cwd: outputRoot, timeout: 10000, maxBuffer: 65536 });
        commands.push({ command: ['git', ...args], exitCode: 0 });
    }
    const patched = await readRegular(destination);
    assert.equal(patched.length, lock.patchedSource.bytes); assert.equal(sha256(patched), lock.patchedSource.sha256);
    // The host patch changes only the two state-holder declarations and their
    // import. Every official contract check and finally block remains identical.
    assert.equal(patched.toString().replace('\nimport org.jetbrains.kotlin.portable.resolve.SerialResolveState\n', '')
        .replaceAll('SerialResolveState<Boolean> = SerialResolveState.withInitial', 'ThreadLocal<Boolean> = ThreadLocal.withInitial'), original.toString());
    const adapterPath = path.join(outputRoot, relativePath(lock.adapter.outputPath));
    await assertNoSymlink(adapterPath); await mkdir(path.dirname(adapterPath), { recursive: true });
    await writeFile(adapterPath, adapter, { flag: 'wx', mode: 0o600 });
    assert.deepEqual(await readRegular(path.join(sourceRoot, pin.path)), original, 'Original source cache changed');
    const receipt = { schemaVersion: 1, kind: 'official-fir-lazy-resolve-serial-preparation', source: lock.source,
        sourceLockSha256: sha256(lockBytes), preparationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
        sourceFile: pin, patch: lock.patch, adapter: lock.adapter, commands,
        originalControlFlowUnchanged: true, originalSourceUnmodified: true,
        files: [{ path: pin.path, ...lock.patchedSource }, { path: lock.adapter.outputPath, bytes: adapter.length, sha256: sha256(adapter) }],
        semantics: lock.semantics, fullFirResolution: 'not-run', browserCompilerBuilt: false, readiness: false };
    const receiptPath = path.join(outputRoot, 'compiler-port-serial-resolve/receipt.json');
    await writeJson(receiptPath, receipt);
    return { commonSources: [destination, adapterPath], replacedOriginalPaths: [pin.path], receiptPath, receipt };
}
