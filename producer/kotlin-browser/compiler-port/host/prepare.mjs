#!/usr/bin/env node
/** Applies the real portable source boundary to an isolated compiler source closure under out/. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertNoSymlink, readRegular, relativePath } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function prepareHostSources({ sourceRoot, outputRoot }) {
    assert(sourceRoot && outputRoot, 'sourceRoot and outputRoot are required');
    sourceRoot = path.resolve(sourceRoot);
    outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep), 'Portable compiler sources must stay under repository out/');
    assert(!sourceRoot.startsWith(outputRoot + path.sep) && sourceRoot !== outputRoot, 'Do not mutate the original source cache');
    await assertNoSymlink(sourceRoot);
    await assertNoSymlink(outputRoot);
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json'));
    const lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    const patchPath = path.join(here, relativePath(lock.patch.path));
    const patch = await readRegular(patchPath);
    assert.equal(patch.byteLength, lock.patch.bytes);
    assert.equal(sha256(patch), lock.patch.sha256);
    const kindsBytes = await readRegular(path.join(here, 'fake-source-kinds.json'));
    assert.equal(sha256(kindsBytes), lock.fakeKindsSha256);
    const kinds = JSON.parse(kindsBytes);
    assert.equal(kinds.kinds.length, 136);
    const originals = [];
    for (const pin of lock.sources) {
        relativePath(pin.path);
        const bytes = await readRegular(path.join(sourceRoot, pin.path));
        assert.equal(bytes.byteLength, pin.bytes, 'Source size mismatch: ' + pin.path);
        assert.equal(sha256(bytes), pin.sha256, 'Source hash mismatch: ' + pin.path);
        assert.equal(createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex'), pin.gitBlobSha1);
        originals.push({ pin, bytes });
    }
    const sourceElement = originals.find(({ pin }) => pin.path === kinds.sourcePath);
    assert.equal(sourceElement.pin.sha256, kinds.sourceSha256);
    const elementText = sourceElement.bytes.toString('utf8');
    const nameSet = new Set();
    for (const kind of kinds.kinds) {
        assert(/^KtFakeSourceElementKind(?:\.[A-Za-z][A-Za-z0-9]*)+$/.test(kind.path));
        assert.equal(kind.fullName, kind.path.slice('KtFakeSourceElementKind.'.length));
        assert.equal(elementText.slice(kind.nameStartUtf16, kind.nameEndUtf16), kind.name);
        assert(!nameSet.has(kind.path));
        nameSet.add(kind.path);
    }
    const names = '/* Generated from the pinned official parser declaration tree; no runtime reflection. */\n' +
        'package org.jetbrains.kotlin\n\n' +
        '@OptIn(org.jetbrains.kotlin.util.ArrayLiteralResolution::class)\n' +
        'internal fun portableFakeSourceElementKindName(kind: KtFakeSourceElementKind): String = when (kind) {\n' +
        kinds.kinds.map((kind) => `    is ${kind.path} -> ${JSON.stringify(kind.fullName)}\n`).join('') + '}\n';
    const generatedRoot = path.join(outputRoot, 'compiler-port-host');
    await mkdir(generatedRoot, { recursive: true });
    const receiptPath = path.join(generatedRoot, 'host-receipt.json');
    try { await readRegular(receiptPath); throw new Error('Host source receipt already exists; choose a fresh output closure'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const { pin, bytes } of originals) {
        const destination = path.join(outputRoot, pin.path);
        await assertNoSymlink(destination);
        try { assert.equal(sha256(await readRegular(destination)), pin.sha256, 'Existing output source differs from original pin'); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await mkdir(path.dirname(destination), { recursive: true });
            await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
        }
    }
    const commands = [];
    for (const args of [['apply', '--check', patchPath], ['apply', patchPath], ['apply', '--reverse', '--check', patchPath]]) {
        await execute('git', args, { cwd: outputRoot, timeout: 10000, maxBuffer: 65536 });
        commands.push({ argv: ['git', ...args], exitCode: 0 });
    }
    const prepared = [];
    for (const { pin } of originals) {
        const filename = path.join(outputRoot, pin.path);
        const bytes = await readRegular(filename);
        assert.equal(bytes.byteLength, pin.portableBytes);
        assert.equal(sha256(bytes), pin.portableSha256, 'Portable source differs from patch pin');
        assert.equal(sha256(await readRegular(path.join(sourceRoot, pin.path))), pin.sha256, 'Original source cache changed');
        prepared.push({ path: pin.path, bytes: bytes.byteLength, sha256: pin.portableSha256, originalSha256: pin.sha256 });
    }
    for (const [filename, bytes] of [['PortableFakeSourceElementNames.kt', Buffer.from(names)],
        ['PortableLightTree.kt', await readRegular(path.join(here, 'PortableLightTree.kt'))],
        ['LibraryPath.kt', await readRegular(path.join(here, 'LibraryPath.kt'))]]) {
        await writeFile(path.join(generatedRoot, filename), bytes, { flag: 'wx', mode: 0o600 });
        prepared.push({ path: 'compiler-port-host/' + filename, bytes: bytes.byteLength, sha256: sha256(bytes), originalSha256: null });
    }
    const receipt = { schemaVersion: 1, kind: 'official-compiler-portable-source-host-preparation', source: lock.source,
        sourceLockSha256: sha256(lockBytes), patch: lock.patch, fakeKindsSha256: lock.fakeKindsSha256,
        fakeSourceKinds: kinds.kinds.length, fakeKindsObserver: { parser: kinds.parser, sourceCommit: kinds.parserSourceCommit,
            snapshotSha256: kinds.parserSnapshotSha256 }, commands, sources: prepared, originalSourcesUnmodified: true,
        readiness: { sourceHostPrepared: true, rawFir: 'not-built', resolvedFir: 'not-built', browserCompiler: false } };
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { outputRoot, receiptPath, receipt, commonSources: prepared.map((pin) => path.join(outputRoot, pin.path)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = process.argv.slice(2);
        const options = {};
        while (args.length) {
            const key = args.shift();
            assert(['--source-root', '--output-root'].includes(key) && args[0] && !options[key], 'Invalid host preparation option');
            options[key] = args.shift();
        }
        const result = await prepareHostSources({ sourceRoot: options['--source-root'], outputRoot: options['--output-root'] });
        console.log(JSON.stringify({ outputRoot: result.outputRoot, receiptPath: result.receiptPath, sources: result.commonSources.length, readiness: result.receipt.readiness }));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
