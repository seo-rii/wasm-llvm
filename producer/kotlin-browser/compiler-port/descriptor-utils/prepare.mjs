/** Prepares all real DescriptorUtils algorithms and the selected portable reflection-class caller. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const REPO = path.resolve(HERE, '../../../..'); const execute = promisify(execFile);

export async function prepareDescriptorUtilsSources({ sourceRoot, outputRoot, jvmAdapter = false }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep));
    assert(typeof jvmAdapter === 'boolean'); await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'official-descriptor-utils-common-source-port');
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    assert.equal(lock.sources.length, 4); assert.equal(lock.methods.length, 70);
    assert.deepEqual(lock.parentTypes, ['ClassDescriptor', 'DeclarationDescriptorWithVisibility', 'PackageFragmentDescriptor', 'BuiltInsPackageFragment']);
    assert.equal(new Set(lock.sources.map(pin => pin.path)).size, 4);
    const originalBytes = new Map();
    for (const pin of lock.sources) originalBytes.set(relativePath(pin.path), verifyFile(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), pin));
    const base = await readRegular(path.join(HERE, relativePath(lock.portable.path)));
    assert.equal(base.length, lock.portable.bytes); assert.equal(sha256(base), lock.portable.sha256);
    assert.deepEqual([...base.toString().matchAll(/\bfun (?:<[^>]+>\s+)?(\w+)\(/g)].map(match => match[1]).sort(), [...lock.methods].sort());
    const keys = await readRegular(path.join(HERE, relativePath(lock.typedKey.path)));
    assert.equal(keys.length, lock.typedKey.bytes); assert.equal(sha256(keys), lock.typedKey.sha256);
    const adapter = await readRegular(path.join(HERE, relativePath(lock.jvmAdapter.path)));
    assert.equal(adapter.length, lock.jvmAdapter.bytes); assert.equal(sha256(adapter), lock.jvmAdapter.sha256);
    assert.equal(sha256(await readRegular(path.join(HERE, relativePath(lock.generator.path)))), lock.generator.sha256);
    assert.equal(base.toString().split('        // JVM_CLASS_PARENT_ADAPTER').length, 2);
    const portable = Buffer.from(base.toString().replace('        // JVM_CLASS_PARENT_ADAPTER', jvmAdapter ? adapter.toString() : '')
        .replace('classifier?.let { it::class }', jvmAdapter ? 'classifier?.let { it.javaClass }' : 'classifier?.let { it::class }'));
    assert.equal(portable.length, jvmAdapter ? lock.jvmAdapter.outputBytes : lock.portable.outputBytes);
    assert.equal(sha256(portable), jvmAdapter ? lock.jvmAdapter.outputSha256 : lock.portable.outputSha256);
    if (!jvmAdapter) assert(!/java\.lang\.Class|\.class\.java|\.isInstance\(/.test(portable.toString()), 'No Java reflection may remain in common parent traversal');
    const patchPath = path.join(HERE, relativePath(lock.patch.path)); const patch = await readRegular(patchPath);
    assert.equal(patch.length, lock.patch.bytes); assert.equal(sha256(patch), lock.patch.sha256);
    const reflectionPath = path.join(outputRoot, relativePath(lock.patch.outputPath));
    await assertNoSymlink(reflectionPath); await mkdir(path.dirname(reflectionPath), { recursive: true, mode: 0o700 });
    await writeFile(reflectionPath, originalBytes.get(lock.patch.outputPath), { flag: 'wx', mode: 0o600 });
    const commands = [];
    for (const args of [['apply', '--check', patchPath], ['apply', patchPath], ['apply', '--reverse', '--check', patchPath]]) {
        await execute('git', args, { cwd: outputRoot, timeout: 10000, maxBuffer: 65536 }); commands.push({ command: 'git', args, exitCode: 0 });
    }
    const reflection = await readRegular(reflectionPath);
    assert.equal(reflection.length, lock.patch.outputBytes); assert.equal(sha256(reflection), lock.patch.outputSha256);
    const root = path.join(outputRoot, 'compiler-port-descriptor-utils'); await mkdir(root, { recursive: true, mode: 0o700 });
    const filename = path.join(outputRoot, relativePath(lock.portable.outputPath));
    await writeFile(filename, portable, { flag: 'wx', mode: 0o600 });
    const keyPath = path.join(root, lock.typedKey.path); await writeFile(keyPath, keys, { flag: 'wx', mode: 0o600 });
    for (const pin of lock.sources) assert.deepEqual(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), originalBytes.get(pin.path));
    const receipt = { schemaVersion: 1, kind: 'official-descriptor-utils-common-source-preparation', source: lock.source,
        sourceLockSha256: sha256(lockBytes), sourceFiles: lock.sources, methods: 70, jvmAdapter,
        preparationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), callerScan: lock.callerScan,
        callerDisposition: lock.callerDisposition, patch: lock.patch, portable: lock.portable, typedKey: lock.typedKey,
        semantics: lock.semantics, integrationGates: lock.integrationGates, originalSourceUnmodified: true, commands,
        files: [{ path: lock.portable.outputPath, bytes: portable.length, sha256: sha256(portable) },
            { path: 'compiler-port-descriptor-utils/' + lock.typedKey.path, bytes: keys.length, sha256: sha256(keys) },
            { path: lock.patch.outputPath, bytes: reflection.length, sha256: sha256(reflection) }],
        wasmBuild: 'not-run: concrete descriptor/type closure required', browserCompilerBuilt: false, readiness: false };
    const receiptPath = path.join(root, 'descriptor-utils-inputs.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receipt, receiptPath, commonSources: [filename, keyPath, reflectionPath], replacedOriginalPaths: lock.replacedOriginalPaths };
}
