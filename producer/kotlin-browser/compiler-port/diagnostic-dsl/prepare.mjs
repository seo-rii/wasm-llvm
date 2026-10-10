import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
export const defaultDiagnosticDslReference = path.join(repository, 'out/kotlin-diagnostic-dsl-reference/sources');
export const DSL_PATH = 'compiler/frontend.common-psi/src/org/jetbrains/kotlin/diagnostics/KtDiagnosticFactoryDsl.kt';
const commit = '4d78aae1e337cd40f69baa865aed950fe807a775';
const names = ['strongWarningWithoutSource', 'warningWithoutSource', 'infoWithoutSource', 'errorWithoutSource', 'SourcelessDiagnosticFactoryDelegateProvider'];

async function loadLock() {
    const bytes = await readRegular(path.join(here, 'sources.lock.json'));
    const lock = JSON.parse(bytes);
    assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.source.commit, commit);
    assert.equal(lock.source.treeSha, '2be662d1ae06bfcf435efbe18191ba5e1e3f035e');
    assert.deepEqual(lock.files.map(pin => pin.path), [DSL_PATH, 'compiler/frontend.common-psi/build.gradle.kts']);
    assert.deepEqual(lock.split.declarations.map(item => item.name), names);
    assert.equal(lock.output.path, DSL_PATH);
    return { bytes, lock };
}

export async function prepareDiagnosticDslReferences({ sourceRoot = defaultDiagnosticDslReference, fetcher = fetch } = {}) {
    sourceRoot = path.resolve(sourceRoot);
    assert(sourceRoot.startsWith(path.join(repository, 'out') + path.sep));
    await assertNoSymlink(sourceRoot);
    const { bytes, lock } = await loadLock();
    for (const pin of lock.files) {
        const filename = path.join(sourceRoot, relativePath(pin.path));
        await assertNoSymlink(filename);
        let original;
        try { original = await readRegular(filename, pin.bytes); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!original) {
            const response = await fetcher(`https://raw.githubusercontent.com/JetBrains/kotlin/${commit}/${pin.path}`,
                { signal: AbortSignal.timeout(60000), redirect: 'error' });
            assert(response.ok, 'Pinned diagnostic DSL download failed: ' + pin.path);
            const chunks = []; let count = 0;
            for await (const chunk of response.body) {
                count += chunk.length; assert(count <= pin.bytes, 'Oversized diagnostic DSL source'); chunks.push(Buffer.from(chunk));
            }
            original = verifyFile(Buffer.concat(chunks), pin);
            await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
            await writeFile(filename, original, { flag: 'wx', mode: 0o600 });
        }
        verifyFile(original, pin);
    }
    return { sourceRoot, source: lock.source, sourceLockSha256: sha256(bytes) };
}

/** Exact original declarations, including context parameters and property delegation. */
export function splitDiagnosticDsl(original, lock) {
    verifyFile(original, lock.files[0]);
    const pieces = [];
    for (const part of [lock.split.header, ...lock.split.imports, ...lock.split.declarations]) {
        const bytes = original.subarray(part.start, part.end);
        assert.equal(bytes.length, part.bytes); assert.equal(sha256(bytes), part.sha256, 'Diagnostic DSL declaration changed');
        pieces.push(bytes);
    }
    const output = Buffer.concat([pieces[0], Buffer.from('\n'), ...pieces.slice(1, 4), Buffer.from('\n'),
        ...pieces.slice(4).flatMap(bytes => [bytes, Buffer.from('\n')])]);
    assert.equal(output.length, lock.output.bytes); assert.equal(sha256(output), lock.output.sha256);
    assert(!/\b(?:PsiElement|KClass|psiType|LanguageFeature)\b/.test(output.toString()), 'Source-bearing DSL leaked into source-free split');
    return output;
}

export async function prepareDiagnosticDsl({ sourceRoot = defaultDiagnosticDslReference, outputRoot } = {}) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep),
        'Diagnostic DSL source/output overlap');
    for (const root of [sourceRoot, outputRoot]) await assertNoSymlink(root);
    const { bytes, lock } = await loadLock();
    const originals = [];
    for (const pin of lock.files) originals.push(verifyFile(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), pin));
    const split = splitDiagnosticDsl(originals[0], lock);
    const root = path.join(outputRoot, 'compiler-port-diagnostic-dsl');
    await mkdir(outputRoot, { recursive: true, mode: 0o700 }); await mkdir(root, { mode: 0o700 });
    const files = [];
    for (const [filename, content] of [...lock.files.map((pin, index) => ['original/' + pin.path, originals[index]]), ['common/' + DSL_PATH, split]]) {
        const target = path.join(root, filename); await assertNoSymlink(target);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { flag: 'wx', mode: 0o600 });
        files.push({ path: filename, bytes: content.length, sha256: sha256(content) });
    }
    const receipt = { schemaVersion: 1, kind: 'official-source-free-diagnostic-dsl-split', source: lock.source,
        sourceLockSha256: sha256(bytes), prepareToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
        originalInputs: lock.files, moduleTree: lock.moduleTree, split: lock.split, files, commonPaths: ['common/' + DSL_PATH],
        metadataChanges: [], declarationBodiesChanged: false, sourceBearingDslIncluded: false,
        replacedOriginalPaths: [], additionalOriginalPaths: lock.files.map(pin => pin.path),
        runtime: 'not-run', fullCompilerAcceptance: false };
    const receiptPath = path.join(root, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { commonSources: [path.join(root, 'common', DSL_PATH)], originalSourceRoot: path.join(root, 'original'),
        replacedOriginalPaths: [], additionalOriginalPaths: receipt.additionalOriginalPaths, sourceFiles: lock.files, receipt, receiptPath };
}

export async function verifyDiagnosticDsl(root) {
    root = path.resolve(root); await assertNoSymlink(root);
    const receiptBytes = await readRegular(path.join(root, 'receipt.json')); const receipt = JSON.parse(receiptBytes);
    const { bytes, lock } = await loadLock();
    const originals = [];
    for (const pin of lock.files) originals.push(verifyFile(await readRegular(path.join(root, 'original', pin.path), pin.bytes), pin));
    const split = splitDiagnosticDsl(originals[0], lock); const actual = await readRegular(path.join(root, 'common', DSL_PATH), split.length);
    assert(actual.equals(split), 'Prepared diagnostic DSL changed');
    const expected = { schemaVersion: 1, kind: 'official-source-free-diagnostic-dsl-split', source: lock.source,
        sourceLockSha256: sha256(bytes), prepareToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
        originalInputs: lock.files, moduleTree: lock.moduleTree, split: lock.split,
        files: [...lock.files.map((pin, index) => ({ path: 'original/' + pin.path, bytes: originals[index].length, sha256: sha256(originals[index]) })),
            { path: 'common/' + DSL_PATH, bytes: split.length, sha256: sha256(split) }], commonPaths: ['common/' + DSL_PATH],
        metadataChanges: [], declarationBodiesChanged: false, sourceBearingDslIncluded: false,
        replacedOriginalPaths: [], additionalOriginalPaths: lock.files.map(pin => pin.path), runtime: 'not-run', fullCompilerAcceptance: false };
    assert.deepEqual(receipt, expected, 'Diagnostic DSL receipt changed');
    return { receipt, receiptSha256: sha256(receiptBytes) };
}
