import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile } from '../../scripts/source.mjs';
import { inventoryTemplates } from './inventory.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
export const defaultReferenceCache = path.join(repository, 'out/kotlin-diagnostic-rendering-reference');
export const defaultAdditionalSourceRoot = path.join(repository, 'out/kotlin-source-closure-reference/sources');

export function validateDiagnosticRenderingRecipe(recipe, closure) {
    assert.equal(recipe.schemaVersion, 1);
    assert.deepEqual(recipe.source, closure.source, 'Diagnostic source identity changed');
    const files = new Map(closure.files.map(pin => [pin.path, pin]));
    const inputPaths = new Set();
    for (const pin of recipe.kotlinInputs) {
        relativePath(pin.path); assert(!inputPaths.has(pin.path), 'Duplicate diagnostic input path'); inputPaths.add(pin.path);
        assert(pin.location === undefined || pin.location === 'additional', 'Unknown diagnostic input location');
        if (pin.location !== 'additional') {
            const original = files.get(pin.path); assert(original, 'Diagnostic input is not in primary source closure');
            for (const key of ['gitBlob', 'bytes', 'sha256']) assert.equal(pin[key], original[key], 'Diagnostic primary source pin changed');
        }
    }
    const outputPaths = new Set();
    for (const pin of recipe.outputs) {
        relativePath(pin.path); assert.equal(pin.path, pin.originalPath, 'Diagnostic logical path must be retained');
        assert(inputPaths.has(pin.originalPath), 'Diagnostic output has no pinned original');
        assert(!outputPaths.has(pin.path), 'Duplicate diagnostic output path'); outputPaths.add(pin.path);
        assert(['message-format-import', 'unchanged-diagnostic-table'].includes(pin.transform), 'Unknown diagnostic transformation');
    }
    for (const table of recipe.tables) assert(inputPaths.has(table.path) && inputPaths.has(table.declarationPath), 'Diagnostic table has unpinned input');
    assert.equal(recipe.outputs.filter(pin => pin.transform === 'message-format-import').length, 3, 'Selected formatter import caller count changed');
    assert.equal(recipe.outputs.filter(pin => pin.transform === 'unchanged-diagnostic-table').length, 1, 'Supplemental table count changed');
    assert.deepEqual(recipe.requiredDiagnosticProfile, { locale: 'en-US', defaultLocale: 'not-used', approvedRawParameterType: 'Int', rawDiagnosticCount: 5,
        parameterRenderers: 'String result retained unchanged', integerSymbols: { digits: '0123456789', groupingSize: 3, groupingSeparator: ',', negativePrefix: '-' } }, 'Audited diagnostic parameter/locale profile changed');
}

/** Download only these source-pinned JDK references, never a JDK distribution or checkout. */
export async function prepareDiagnosticRenderingReferences({ cacheRoot = defaultReferenceCache } = {}) {
    cacheRoot = path.resolve(cacheRoot);
    assert(cacheRoot.startsWith(path.join(repository, 'out') + path.sep), 'Reference cache must stay under repository out/');
    await assertNoSymlink(cacheRoot);
    const recipe = JSON.parse(await readRegular(path.join(here, 'rendering.recipe.json')));
    await mkdir(cacheRoot, { recursive: true });
    for (const pin of recipe.jdk.files) {
        const filename = path.join(cacheRoot, relativePath(pin.path));
        try { verifyFile(await readRegular(filename, pin.bytes), pin); continue; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const url = 'https://raw.githubusercontent.com/openjdk/jdk17u/' + recipe.jdk.commit + '/' + pin.sourcePath;
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        assert(response.ok && response.body, 'Pinned JDK reference download failed: ' + pin.path);
        const reader = response.body.getReader(), chunks = [];
        let size = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                assert(size <= pin.bytes, 'Pinned JDK reference exceeds expected size');
                chunks.push(value);
            }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        const bytes = verifyFile(Buffer.concat(chunks), pin);
        await assertNoSymlink(filename);
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    }
    return { cacheRoot, source: { repository: recipe.jdk.repository, commit: recipe.jdk.commit }, files: recipe.jdk.files };
}

/** Keep every official renderer body; bind only its java.text.MessageFormat import. */
export async function prepareDiagnosticRendering({ sourceRoot, outputRoot, referenceCache = defaultReferenceCache,
    additionalSourceRoot = defaultAdditionalSourceRoot } = {}) {
    assert(sourceRoot && outputRoot, 'sourceRoot and outputRoot required');
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); referenceCache = path.resolve(referenceCache);
    additionalSourceRoot = path.resolve(additionalSourceRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep), 'Rendering output must stay under repository out/');
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Do not modify original source cache');
    assert(additionalSourceRoot !== outputRoot && !additionalSourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(additionalSourceRoot + path.sep), 'Do not modify supplemental original cache');
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot); await assertNoSymlink(referenceCache); await assertNoSymlink(additionalSourceRoot);
    const recipeBytes = await readRegular(path.join(here, 'rendering.recipe.json'));
    const recipe = JSON.parse(recipeBytes);
    assert.equal(recipe.schemaVersion, 1); assert.equal(recipe.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    const closureBytes = await readRegular(path.join(here, '../closure.lock.json'));
    assert.equal(sha256(closureBytes), recipe.sourceClosureLockSha256);
    const closure = JSON.parse(closureBytes); assert.deepEqual(closure.source, recipe.source);
    validateDiagnosticRenderingRecipe(recipe, closure);
    const originals = new Map();
    for (const pin of recipe.kotlinInputs) {
        assert(!originals.has(pin.path), 'Duplicate diagnostic input path');
        const root = pin.location === 'additional' ? additionalSourceRoot : sourceRoot;
        originals.set(pin.path, verifyFile(await readRegular(path.join(root, relativePath(pin.path)), pin.bytes), pin));
    }
    for (const pin of recipe.jdk.files) verifyFile(await readRegular(path.join(referenceCache, relativePath(pin.path)), pin.bytes), pin);
    verifyFile(await readRegular(path.join(here, 'LICENSE.OpenJDK'), recipe.license.bytes), recipe.license);
    const ported = verifyFile(await readRegular(path.join(here, recipe.portedSource.path), recipe.portedSource.bytes), recipe.portedSource);
    const tables = recipe.tables.map((table) => ({ ...table, text: originals.get(table.path).toString('utf8'), declarations: originals.get(table.declarationPath).toString('utf8') }));
    const inventory = inventoryTemplates(tables);
    const ledger = await readRegular(path.join(here, 'templates.lock.json'), recipe.templateInventory.bytes);
    assert.equal(sha256(ledger), recipe.templateInventory.sha256); assert.deepEqual(JSON.parse(ledger), inventory);
    assert.equal(inventory.records.length, recipe.templateInventory.registrationCalls);
    assert.equal(inventory.records.filter(record => record.mode === 'parameterized-MessageFormat').length, recipe.templateInventory.parameterizedCalls);
    assert.equal(inventory.records.filter(record => record.mode === 'simple-no-MessageFormat').length, recipe.templateInventory.simpleCalls);
    const changed = new Set(recipe.outputs.map((pin) => pin.originalPath));
    const callerInventory = [];
    for (const pin of closure.files) {
        if (!pin.compile || !pin.path.endsWith('.kt')) continue;
        const bytes = verifyFile(await readRegular(path.join(sourceRoot, relativePath(pin.path)), pin.bytes), pin);
        const text = bytes.toString('utf8');
        if (/^import java\.text\.MessageFormat\b/m.test(text)) assert(changed.has(pin.path), 'Unclosed selected MessageFormat caller: ' + pin.path);
        if (/java\.text\.MessageFormat\s*\(/.test(text)) assert.fail('Unexpected qualified MessageFormat constructor: ' + pin.path);
        callerInventory.push({ path: pin.path, sha256: pin.sha256 });
    }
    const prepared = [];
    for (const pin of recipe.outputs) {
        const original = originals.get(pin.originalPath).toString('utf8');
        assert(['message-format-import', 'unchanged-diagnostic-table'].includes(pin.transform), 'Unknown rendering transformation');
        if (pin.transform === 'message-format-import') assert.equal(original.split('import java.text.MessageFormat\n').length, 2, 'Unexpected renderer MessageFormat import shape');
        else assert(!original.includes('java.text.MessageFormat'), 'Unexpected supplemental MessageFormat caller');
        const variant = Buffer.from(pin.transform === 'message-format-import' ? original.replace('import java.text.MessageFormat\n', 'import org.jetbrains.kotlin.portable.diagnostics.DiagnosticMessageFormat as MessageFormat\n') : original);
        verifyFile(variant, pin);
        prepared.push({ path: pin.originalPath, bytes: variant });
    }
    const root = path.join(outputRoot, 'compiler-port-diagnostic-rendering');
    await assertNoSymlink(root); await mkdir(outputRoot, { recursive: true }); await mkdir(root, { recursive: false });
    const commonSources = [];
    for (const file of [...prepared, { path: recipe.portedSource.path, bytes: ported }]) {
        const filename = path.join(root, relativePath(file.path));
        await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, file.bytes, { flag: 'wx', mode: 0o600 }); commonSources.push(filename);
    }
    await writeFile(path.join(root, 'LICENSE.OpenJDK'), await readRegular(path.join(here, 'LICENSE.OpenJDK')), { flag: 'wx', mode: 0o600 });
    for (const pin of recipe.kotlinInputs) verifyFile(await readRegular(path.join(pin.location === 'additional' ? additionalSourceRoot : sourceRoot, pin.path), pin.bytes), pin);
    const replacedOriginalPaths = recipe.outputs.map((pin) => pin.originalPath);
    const receipt = { schemaVersion: 1, kind: 'official-diagnostic-rendering-host-boundary', source: recipe.source,
        recipeSha256: sha256(recipeBytes), sourceClosureLockSha256: sha256(closureBytes), kotlinInputs: recipe.kotlinInputs,
        jdk: recipe.jdk, outputs: recipe.outputs, portedSource: recipe.portedSource, templateInventory: recipe.templateInventory,
        registrationCalls: inventory.records.length, rawParameterProfile: inventory.rawParameterProfile,
        requiredDiagnosticProfile: recipe.requiredDiagnosticProfile, unclosedJdkEdges: recipe.unclosedJdkEdges,
        callerAudit: { selectedKotlinFiles: callerInventory.length, inventorySha256: sha256(Buffer.from(JSON.stringify(callerInventory))), selectedMessageFormatImportCallers: 3 },
        preparationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), inventoryToolSha256: sha256(await readRegular(path.join(here, 'inventory.mjs'))),
        supplementalOriginals: recipe.kotlinInputs.filter(pin => pin.location === 'additional'),
        algorithmBoundary: 'Three MessageFormat import bindings only; the additional Web Common table and every rendering body unchanged',
        classIdentityBoundary: 'No javaClass operation occurs in these three bodies; no JVM class-name output is replaced. Other compiler class-identity boundaries remain separate.',
        replacedOriginalPaths, sourceSetExclusions: [], originalSourcesUnmodified: true,
        fullJdkFormatter: 'not-ported', diagnosticWasmExecution: 'not-run', resolvedFirExecution: 'not-run', browserCompiler: 'not-built', languageReadiness: false };
    const receiptPath = path.join(root, 'diagnostic-rendering-inputs.json');
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { commonSources, replacedOriginalPaths, sourceSetExclusions: [], supplementalOriginals: receipt.supplementalOriginals,
        requiredDiagnosticProfile: receipt.requiredDiagnosticProfile, receiptPath, receipt };
}
