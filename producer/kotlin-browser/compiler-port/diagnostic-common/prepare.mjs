import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const defaultReference = path.join(repository, 'out/kotlin-diagnostic-common-reference/sources');
const commit = '4d78aae1e337cd40f69baa865aed950fe807a775';

async function loadLock() {
    const bytes = await readRegular(path.join(here, 'sources.lock.json'));
    const lock = JSON.parse(bytes);
    assert.equal(lock.source.commit, commit);
    assert.equal(lock.source.treeSha, '2be662d1ae06bfcf435efbe18191ba5e1e3f035e');
    assert.deepEqual(lock.files.map(pin => pin.path), [
        'compiler/frontend.common-psi/src/org/jetbrains/kotlin/diagnostics/rendering/CommonRenderers.kt',
        'compiler/frontend.common-psi/src/org/jetbrains/kotlin/diagnostics/rendering/LanguageFeatureMessageRenderer.kt',
        'compiler/frontend.common-psi/gen/org/jetbrains/kotlin/diagnostics/rendering/FeatureToFlagMapGenerated.kt',
    ]);
    return { bytes, lock };
}

export async function prepareDiagnosticCommonReferences({ sourceRoot = defaultReference, fetcher = fetch } = {}) {
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
            assert(response.ok, 'Pinned diagnostic source download failed: ' + pin.path);
            const chunks = []; let count = 0;
            for await (const chunk of response.body) {
                count += chunk.length; assert(count <= pin.bytes, 'Oversized diagnostic source'); chunks.push(Buffer.from(chunk));
            }
            original = verifyFile(Buffer.concat(chunks), pin);
            await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
            await writeFile(filename, original, { flag: 'wx', mode: 0o600 });
        }
        verifyFile(original, pin);
    }
    return { sourceRoot, source: lock.source, sourceLockSha256: sha256(bytes) };
}

// This is a genuine host binding: each target renders its own actual Throwable
// stack trace. Keep the original UTF-16 truncation and ellipsis policy.
export function transformDiagnosticCommon(original, filename) {
    let code = original.toString('utf8');
    if (filename.endsWith('/CommonRenderers.kt')) {
        for (const binding of ['com.intellij.openapi.util.text.StringUtil', 'java.io.PrintWriter', 'java.io.StringWriter']) {
            const line = `import ${binding}\n`;
            assert.equal(code.split(line).length, 2, 'Unexpected diagnostic host import');
            code = code.replace(line, '');
        }
        const before = '        val writer = StringWriter()\n        it.printStackTrace(PrintWriter(writer))\n        StringUtil.first(writer.toString(), 2048, true)';
        const after = '        val stackTrace = it.stackTraceToString()\n        if (stackTrace.length <= 2048) stackTrace else stackTrace.substring(0, 2048) + "..."';
        assert.equal(code.split(before).length, 2, 'Unexpected original Throwable renderer');
        code = code.replace(before, after);
    }
    if (/@Jvm\w+\b/.test(code)) {
        const declaration = /^package[^\r\n]+/m.exec(code); assert(declaration);
        const end = declaration.index + declaration[0].length;
        code = code.slice(0, end) + '\nimport kotlin.jvm.*' + code.slice(end);
    }
    return Buffer.from(code);
}

export async function prepareDiagnosticCommon({ sourceRoot = defaultReference, outputRoot } = {}) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    for (const root of [sourceRoot, outputRoot]) await assertNoSymlink(root);
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep),
        'Diagnostic source/output overlap');
    const { bytes, lock } = await loadLock();
    const originals = [];
    for (const pin of lock.files) originals.push(verifyFile(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), pin));
    const root = path.join(outputRoot, 'compiler-port-diagnostic-common');
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await mkdir(root, { mode: 0o700 });
    const files = [], commonSources = [];
    for (const [index, pin] of lock.files.entries()) {
        const original = originals[index];
        const originalPath = 'original/' + pin.path;
        const transformedPath = 'common/' + pin.path;
        const transformed = transformDiagnosticCommon(original, pin.path);
        for (const [target, content] of [[originalPath, original], [transformedPath, transformed]]) {
            const filename = path.join(root, target);
            await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
            await writeFile(filename, content, { flag: 'wx', mode: 0o600 });
            files.push({ path: target, bytes: content.length, sha256: sha256(content) });
        }
        commonSources.push(path.join(root, transformedPath));
    }
    const receipt = { schemaVersion: 1, kind: 'official-common-diagnostic-renderer-preparation', source: lock.source,
        sourceLockSha256: sha256(bytes), prepareToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
        originalInputs: lock.files, files, commonPaths: commonSources.map(filename => path.relative(root, filename)),
        hostBinding: 'actual kotlin.Throwable.stackTraceToString, original 2048 UTF-16 units plus ellipsis',
        diagnosticDeclarationsRemoved: false, languageFeatureMappingsRemoved: false,
        fullRendererExecution: 'not-run', fullCompilerAcceptance: false };
    const receiptPath = path.join(root, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { commonSources, replacedOriginalPaths: [], receipt, receiptPath };
}

export async function verifyDiagnosticCommon(root) {
    root = path.resolve(root); await assertNoSymlink(root);
    const receiptBytes = await readRegular(path.join(root, 'receipt.json'));
    const receipt = JSON.parse(receiptBytes); const { bytes, lock } = await loadLock();
    assert.equal(receipt.kind, 'official-common-diagnostic-renderer-preparation');
    assert.deepEqual(receipt.source, lock.source); assert.deepEqual(receipt.originalInputs, lock.files);
    assert.equal(receipt.sourceLockSha256, sha256(bytes));
    assert.equal(receipt.prepareToolSha256, sha256(await readRegular(fileURLToPath(import.meta.url))));
    assert.deepEqual(receipt.commonPaths, lock.files.map(pin => 'common/' + pin.path));
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.hostBinding, 'actual kotlin.Throwable.stackTraceToString, original 2048 UTF-16 units plus ellipsis');
    assert.equal(receipt.diagnosticDeclarationsRemoved, false);
    assert.equal(receipt.languageFeatureMappingsRemoved, false);
    assert.equal(receipt.fullRendererExecution, 'not-run');
    assert.equal(receipt.fullCompilerAcceptance, false);
    const expected = [];
    for (const pin of lock.files) {
        const original = verifyFile(await readRegular(path.join(root, 'original', pin.path), pin.bytes), pin);
        const transformed = transformDiagnosticCommon(original, pin.path);
        for (const [prefix, content] of [['original/', original], ['common/', transformed]]) {
            const filename = prefix + pin.path;
            const actual = await readRegular(path.join(root, filename), content.length); assert(actual.equals(content));
            expected.push({ path: filename, bytes: content.length, sha256: sha256(content) });
        }
    }
    assert.deepEqual(receipt.files, expected, 'Diagnostic source receipt changed');
    return { receipt, receiptSha256: sha256(receiptBytes) };
}
