import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const originalPath = 'core/descriptors/src/org/jetbrains/kotlin/resolve/MemberComparator.java';
const outputPath = 'compiler-port-member-comparator/MemberComparator.kt';

async function inputs(sourceRoot) {
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'official-full-member-comparator-common-source-port');
    assert.equal(lock.languageReadiness, false);
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    const closureBytes = await readRegular(path.join(here, '../closure.lock.json'));
    assert.equal(sha256(closureBytes), lock.primaryClosureSha256);
    const closure = JSON.parse(closureBytes);
    assert.deepEqual(lock.source, closure.source);
    assert.equal(lock.original.path, originalPath);
    assert.deepEqual(lock.original, closure.files.find(pin => pin.path === originalPath));
    assert.equal(lock.portable.path, 'MemberComparator.kt'); assert.equal(lock.outputPath, outputPath);
    const original = verifyFile(await readRegular(path.join(sourceRoot, originalPath)), lock.original);
    const portable = verifyFile(await readRegular(path.join(here, lock.portable.path)), lock.portable);
    const header = original.subarray(0, original.indexOf(Buffer.from('\npackage ')));
    assert.deepEqual(portable.subarray(0, portable.indexOf(Buffer.from('\npackage '))), header, 'Original license header changed');
    assert.deepEqual(lock.dependencies, []);
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(here, pin.path)), pin);
    return { lock, lockBytes, original, portable };
}

function receiptFor(input, toolHash) {
    return { schemaVersion: 1, kind: 'official-full-member-comparator-common-source-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: toolHash,
        original: input.lock.original, portable: input.lock.portable, dependencies: input.lock.dependencies,
        files: [{ path: outputPath, bytes: input.portable.length, sha256: sha256(input.portable), originalSha256: sha256(input.original) }],
        referenceFiles: [{ path: 'reference/' + originalPath, bytes: input.original.length, sha256: sha256(input.original) }],
        replacedOriginalPaths: [originalPath], sourceAlgorithm: input.lock.sourceAlgorithm, hostAdaptations: input.lock.hostAdaptations,
        originalSourceUnmodified: true, fullCommonDescriptorGraph: false, wasmRuntime: 'not-run', browserRuntime: 'not-run',
        fullCompilerBuilt: false, languageReadiness: false };
}

export async function prepareMemberComparatorSources({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Input/output overlap');
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const input = await inputs(sourceRoot);
    const toolHash = sha256(await readRegular(fileURLToPath(import.meta.url)));
    for (const [relative, bytes] of [['reference/' + originalPath, input.original], [outputPath, input.portable]]) {
        const filename = path.join(outputRoot, relative); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    }
    assert.deepEqual(await readRegular(path.join(sourceRoot, originalPath)), input.original);
    const receipt = receiptFor(input, toolHash), receiptPath = path.join(outputRoot, 'member-comparator-inputs.json');
    await writeJson(receiptPath, receipt);
    return { outputRoot, receipt, receiptPath, commonSources: [path.join(outputRoot, outputPath)], replacedOriginalPaths: [originalPath] };
}

export async function verifyMemberComparator(root) {
    root = path.resolve(root); assert(root.startsWith(path.join(repository, 'out') + path.sep)); await assertNoSymlink(root);
    const receiptBytes = await readRegular(path.join(root, 'member-comparator-inputs.json')), receipt = JSON.parse(receiptBytes);
    const input = await inputs(path.join(root, 'reference'));
    assert.deepEqual(await readRegular(path.join(root, outputPath)), input.portable);
    assert.deepEqual(receipt, receiptFor(input, sha256(await readRegular(fileURLToPath(import.meta.url)))));
    return { receipt, receiptSha256: sha256(receiptBytes) };
}
