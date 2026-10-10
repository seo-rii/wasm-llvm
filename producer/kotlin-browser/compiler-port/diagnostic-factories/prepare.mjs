import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile } from '../../scripts/source.mjs';
import { encodeBindings, transformFactorySource, transformGeneratedDiagnostics } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');

export async function prepareDiagnosticFactories({ sourceRoot, outputRoot } = {}) {
    assert(sourceRoot && outputRoot, 'sourceRoot and outputRoot required');
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep), 'Diagnostic factories output must stay under repository out/');
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Do not modify the original source cache');
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const recipeBytes = await readRegular(path.join(here, 'diagnostic-factories.recipe.json'));
    const recipe = JSON.parse(recipeBytes);
    assert.equal(recipe.schemaVersion, 1); assert.equal(recipe.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    const closureBytes = await readRegular(path.join(here, '../closure.lock.json'));
    assert.equal(sha256(closureBytes), recipe.sourceClosureLockSha256, 'Selected source closure changed');
    const closure = JSON.parse(closureBytes);
    assert.deepEqual(closure.source, recipe.source);
    const originals = new Map();
    for (const pin of recipe.originals) originals.set(pin.path,
        verifyFile(await readRegular(path.join(sourceRoot, relativePath(pin.path)), pin.bytes), pin));
    const prepared = [];
    const bindings = [];
    for (const output of recipe.outputs) {
        const text = originals.get(output.originalPath).toString('utf8');
        const result = output.kind === 'factory' ? transformFactorySource(text) : transformGeneratedDiagnostics(text, output.table, output.diagnostics);
        const bytes = Buffer.from(result.text);
        assert.equal(bytes.length, output.bytes); assert.equal(sha256(bytes), output.sha256, 'Diagnostic variant output changed');
        assert.equal(sha256(Buffer.from(JSON.stringify(result.deletions))), output.deletionsSha256, 'Diagnostic metadata deletion provenance changed');
        prepared.push({ pin: output, bytes, result });
        if (result.bindings) bindings.push(...result.bindings);
    }
    const bindingBytes = encodeBindings(bindings);
    assert.equal(bindingBytes.length, recipe.classBindings.bytes); assert.equal(sha256(bindingBytes), recipe.classBindings.sha256);
    assert.deepEqual(await readRegular(path.join(here, relativePath(recipe.classBindings.path)), recipe.classBindings.bytes), bindingBytes);
    const changedPaths = new Set(recipe.outputs.map((pin) => pin.originalPath));
    const callerInventory = [];
    for (const pin of closure.files) {
        if (!pin.compile || !pin.path.endsWith('.kt') || changedPaths.has(pin.path)) continue;
        const bytes = verifyFile(await readRegular(path.join(sourceRoot, relativePath(pin.path)), pin.bytes), pin);
        const text = bytes.toString('utf8');
        assert(!/\b(?:psiType|getPsiType)\b/.test(text), 'Unexpected diagnostic PSI metadata reader in selected source: ' + pin.path);
        assert(!/\bKtDiagnosticFactory(?:N|ForDeprecation[0-4]|[0-4])\s*(?:<[^\n]*?>)?\s*\(/.test(text), 'Unexpected selected diagnostic factory constructor caller: ' + pin.path);
        callerInventory.push({ path: pin.path, sha256: pin.sha256 });
    }
    const root = path.join(outputRoot, 'compiler-port-diagnostic-factories');
    await assertNoSymlink(root); await mkdir(outputRoot, { recursive: true }); await mkdir(root, { recursive: false });
    const commonSources = [];
    for (const { pin, bytes } of prepared) {
        const filename = path.join(root, relativePath(pin.originalPath));
        await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        commonSources.push(filename);
    }
    await writeFile(path.join(root, 'jvm-psi-class-bindings.json'), bindingBytes, { flag: 'wx', mode: 0o600 });
    for (const pin of recipe.originals) verifyFile(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), pin);
    const replacedOriginalPaths = recipe.outputs.map((pin) => pin.originalPath);
    const receipt = { schemaVersion: 1, kind: 'official-browser-diagnostic-factory-source-variant', source: recipe.source,
        recipeSha256: sha256(recipeBytes), sourceClosureLockSha256: sha256(closureBytes), originals: recipe.originals,
        outputs: recipe.outputs, classBindings: recipe.classBindings,
        deletedMetadataSpans: prepared.map(({ pin, result }) => ({ path: pin.originalPath, spans: result.deletions.length, deletionsSha256: pin.deletionsSha256 })),
        diagnosticDeclarations: bindings.length, retainedAlgorithm: 'Only recorded metadata spans deleted; all other source bytes preserved',
        callerAudit: { selectedKotlinFiles: callerInventory.length, inventorySha256: sha256(Buffer.from(JSON.stringify(callerInventory))),
            unexpectedMetadataReaders: 0, unexpectedConstructorCallers: 0 },
        replacedOriginalPaths, sourceSetExclusions: [], originalSourcesUnmodified: true,
        diagnosticRuntime: 'not-run', resolvedFirExecution: 'not-run', wasmRuntime: 'not-run', browserCompiler: 'not-built', languageReadiness: false };
    const receiptPath = path.join(root, 'diagnostic-factory-inputs.json');
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { commonSources, replacedOriginalPaths, sourceSetExclusions: [], receiptPath, receipt };
}
