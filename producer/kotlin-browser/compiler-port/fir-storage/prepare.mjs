/** Verifies and prepares real FIR2IR storage, matching, IR lock and delegate sources. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const execute = promisify(execFile);

export async function prepareFirStorageSources({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) &&
        !outputRoot.startsWith(sourceRoot + path.sep), 'Source and output trees must not overlap');
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'official-fir-ir-serial-cache-lock-source-port');
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    assert.equal(lock.hostProfile, 'serial-compiler-worker'); assert.equal(lock.sources.length, 11);
    assert.equal(sha256(await readRegular(path.join(HERE, '../closure.lock.json'))), lock.sourceClosureLockSha256);
    assert.equal(new Set(lock.sources.map(pin => pin.path)).size, lock.sources.length);
    assert.equal(lock.referenceDependencies.length, 6);
    assert.equal(new Set([...lock.sources, ...lock.referenceDependencies].map(pin => relativePath(pin.path))).size, 17);
    assert.deepEqual(lock.replacedOriginalPaths, lock.sources.map(pin => pin.path));
    const references = new Map();
    for (const pin of lock.referenceDependencies) {
        const relative = relativePath(pin.path);
        references.set(relative, verifyFile(await readRegular(path.join(sourceRoot, relative), pin.bytes), pin));
    }
    const originals = new Map();
    for (const pin of lock.sources) {
        const relative = relativePath(pin.path);
        const bytes = verifyFile(await readRegular(path.join(sourceRoot, relative), pin.bytes), pin);
        originals.set(relative, bytes);
        const filename = path.join(outputRoot, relative); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    }
    const generator = await readRegular(path.join(HERE, relativePath(lock.generator.path)));
    assert.equal(sha256(generator), lock.generator.sha256);
    const adapter = await readRegular(path.join(HERE, relativePath(lock.adapter.path)));
    assert.equal(adapter.length, lock.adapter.bytes); assert.equal(sha256(adapter), lock.adapter.sha256);
    assert(!/\bjava\.|\bThread\b|IdentityHashMap|synchronized\(/.test(adapter.toString()));
    const patchFile = path.join(HERE, relativePath(lock.patch.path)); const patch = await readRegular(patchFile);
    assert.equal(patch.length, lock.patch.bytes); assert.equal(sha256(patch), lock.patch.sha256);
    const commands = [];
    for (const args of [['apply', '--check', patchFile], ['apply', patchFile], ['apply', '--reverse', '--check', patchFile]]) {
        await execute('git', args, { cwd: outputRoot, timeout: 10000, maxBuffer: 65536 });
        commands.push({ command: 'git', args, exitCode: 0 });
    }
    const files = [];
    for (const pin of lock.sources) {
        const bytes = await readRegular(path.join(outputRoot, pin.path));
        assert.equal(bytes.length, pin.patchedBytes); assert.equal(sha256(bytes), pin.patchedSha256);
        assert.deepEqual(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), originals.get(pin.path));
        files.push({ path: pin.path, bytes: bytes.length, sha256: sha256(bytes), originalSha256: pin.sha256 });
    }
    for (const pin of lock.referenceDependencies) assert.deepEqual(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), references.get(pin.path));
    const filename = path.join(outputRoot, relativePath(lock.adapter.outputPath)); await assertNoSymlink(filename);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, adapter, { flag: 'wx', mode: 0o600 });
    files.push({ path: lock.adapter.outputPath, bytes: adapter.length, sha256: sha256(adapter), originalSha256: null });
    const receipt = { schemaVersion: 1, kind: 'official-fir-ir-serial-cache-lock-source-preparation', source: lock.source,
        hostProfile: lock.hostProfile, sourceLockSha256: sha256(lockBytes),
        preparationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
        sourceFiles: lock.sources, referenceDependencies: lock.referenceDependencies, adapter: lock.adapter, patch: lock.patch,
        usedOperations: lock.usedOperations, callbackAudit: lock.callbackAudit, ownership: lock.ownership,
        semantics: lock.semantics, integrationGates: lock.integrationGates, commands, files,
        originalSourceUnmodified: true, browserCompilerBuilt: false, readiness: false };
    const receiptPath = path.join(outputRoot, 'compiler-port-fir-storage/fir-storage-inputs.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receipt, receiptPath, commonSources: files.map(pin => path.join(outputRoot, pin.path)),
        replacedOriginalPaths: lock.replacedOriginalPaths };
}
