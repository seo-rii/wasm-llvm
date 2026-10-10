import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readRegular, sha256, verifyFile } from '../../scripts/source.mjs';
import { inventoryTemplates } from './inventory.mjs';
import { literalDiagnosticCases, rawIntDiagnosticCases } from './build-probe.mjs';
import { defaultAdditionalSourceRoot, defaultReferenceCache, prepareDiagnosticRendering, validateDiagnosticRenderingRecipe } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources');
const recipe = JSON.parse(await readRegular(path.join(here, 'rendering.recipe.json')));
const closure = JSON.parse(await readRegular(path.join(here, '../closure.lock.json')));
const inventory = JSON.parse(await readRegular(path.join(here, 'templates.lock.json')));

test('recipe preserves source pins, explicit profile and portable source/license attribution', async () => {
    validateDiagnosticRenderingRecipe(recipe, closure);
    for (const pin of [recipe.portedSource, recipe.license, recipe.templateInventory]) verifyFile(await readRegular(path.join(here, pin.path)), pin);
    const formatter = (await readRegular(path.join(here, recipe.portedSource.path))).toString('utf8');
    assert.match(formatter, /Integer\.parseInt portions: Copyright \(c\) 1994, 2021/);
    assert.match(formatter, /Classpath/);
    assert.match((await readRegular(path.join(here, recipe.license.path))).toString('utf8'), /"CLASSPATH" EXCEPTION TO THE GPL/);
    assert.equal(sha256(await readRegular(path.join(here, '../closure.lock.json'))), recipe.sourceClosureLockSha256);
});

test('all real registrations and five raw Int boundaries reproduce from pinned primary and supplemental sources', async () => {
    const inputs = new Map();
    for (const pin of recipe.kotlinInputs) {
        const root = pin.location === 'additional' ? defaultAdditionalSourceRoot : sourceRoot;
        inputs.set(pin.path, verifyFile(await readRegular(path.join(root, pin.path)), pin).toString('utf8'));
    }
    const actual = inventoryTemplates(recipe.tables.map(table => ({ ...table, text: inputs.get(table.path), declarations: inputs.get(table.declarationPath) })));
    assert.deepEqual(actual, inventory);
    assert.equal(actual.records.length, recipe.templateInventory.registrationCalls);
    assert.equal(actual.records.filter(record => record.table === 'web-common').length, 30);
    assert.equal(actual.records.filter(record => record.rawParameters.length).length, 5);
    assert.equal(actual.records.filter(record => record.mode === 'parameterized-MessageFormat').length, 471);
});

test('recipe rejects widened profiles, changed source pins, duplicate outputs and unsafe logical paths', () => {
    for (const mutate of [
        r => { r.requiredDiagnosticProfile.approvedRawParameterType = 'Any'; },
        r => { r.kotlinInputs[0].sha256 = '0'.repeat(64); },
        r => { r.kotlinInputs.push(r.kotlinInputs[0]); },
        r => { r.outputs.push(r.outputs[0]); },
        r => { r.outputs[0].path = '../changed.kt'; },
        r => { r.tables[0].declarationPath = 'unreviewed.kt'; },
        r => { r.outputs[0].transform = 'replace-renderer-body'; }
    ]) {
        const changed = structuredClone(recipe); mutate(changed);
        assert.throws(() => validateDiagnosticRenderingRecipe(changed, closure));
    }
});

test('probe executes exact raw Int prefix expressions while marking unresolved warning suffixes separately', async () => {
    const literal = literalDiagnosticCases(inventory);
    assert(literal.patterns > 400);
    assert(literal.deferred.length > 0);
    const pin = recipe.kotlinInputs.find(input => input.path.endsWith('/FirErrorsDefaultMessages.kt'));
    const original = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin).toString('utf8');
    const raw = rawIntDiagnosticCases(inventory, original);
    assert.equal(raw.patterns, 5); assert.equal(raw.samples, 40); assert.equal(raw.warningSuffixExecution, 'not-run');
    assert.match(raw.source, /val wrongNumberOfTypeArguments = "\{0,choice,/);
    for (const name of inventory.rawParameterProfile.diagnostics) assert(raw.source.includes(name));
    assert.throws(() => rawIntDiagnosticCases(inventory, original.replace('val wrongNumberOfTypeArguments', 'val changedPrefix')));
});

test('preparation preserves every renderer body, unchanged supplemental table and input bytes; cannot overwrite receipt', async () => {
    const root = await mkdtemp(path.join(repository, 'out/kotlin-diagnostic-rendering-integrity-'));
    try {
        const outputRoot = path.join(root, 'prepared');
        const prepared = await prepareDiagnosticRendering({ sourceRoot, outputRoot });
        assert.equal(prepared.commonSources.length, 5);
        assert.equal(prepared.replacedOriginalPaths.length, 4);
        assert.equal(prepared.supplementalOriginals.length, 2);
        assert.deepEqual(prepared.sourceSetExclusions, []);
        assert.equal(prepared.receipt.languageReadiness, false);
        assert.equal(prepared.receipt.resolvedFirExecution, 'not-run');
        for (const pin of recipe.outputs) {
            const input = recipe.kotlinInputs.find(item => item.path === pin.originalPath);
            const original = verifyFile(await readRegular(path.join(input.location === 'additional' ? defaultAdditionalSourceRoot : sourceRoot, input.path)), input).toString('utf8');
            const output = verifyFile(await readRegular(path.join(outputRoot, 'compiler-port-diagnostic-rendering', pin.path)), pin).toString('utf8');
            assert.equal(output, pin.transform === 'message-format-import'
                ? original.replace('import java.text.MessageFormat\n', 'import org.jetbrains.kotlin.portable.diagnostics.DiagnosticMessageFormat as MessageFormat\n') : original);
        }
        const before = sha256(await readRegular(prepared.receiptPath));
        await assert.rejects(prepareDiagnosticRendering({ sourceRoot, outputRoot }), { code: 'EEXIST' });
        assert.equal(sha256(await readRegular(prepared.receiptPath)), before);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('changed original and absent supplemental input fail before publishing any preparation output', async () => {
    const root = await mkdtemp(path.join(repository, 'out/kotlin-diagnostic-rendering-integrity-'));
    try {
        const changedRoot = path.join(root, 'changed');
        const first = path.join(changedRoot, recipe.kotlinInputs[0].path);
        await mkdir(path.dirname(first), { recursive: true }); await writeFile(first, 'changed', { flag: 'wx' });
        const outputRoot = path.join(root, 'prepared');
        await assert.rejects(prepareDiagnosticRendering({ sourceRoot: changedRoot, outputRoot }), /Pinned source content mismatch/);
        await assert.rejects(readRegular(path.join(outputRoot, 'compiler-port-diagnostic-rendering/diagnostic-rendering-inputs.json')), { code: 'ENOENT' });
        await assert.rejects(prepareDiagnosticRendering({ sourceRoot, outputRoot, additionalSourceRoot: path.join(root, 'missing') }), { code: 'ENOENT' });
        await assert.rejects(readRegular(path.join(outputRoot, 'compiler-port-diagnostic-rendering/diagnostic-rendering-inputs.json')), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('preparation rejects symlink, either original-cache overlap and missing reference input', async () => {
    const root = await mkdtemp(path.join(repository, 'out/kotlin-diagnostic-rendering-integrity-'));
    try {
        await symlink(sourceRoot, path.join(root, 'alias'));
        await assert.rejects(prepareDiagnosticRendering({ sourceRoot: path.join(root, 'alias'), outputRoot: path.join(root, 'prepared') }), /Symlink/);
        await assert.rejects(prepareDiagnosticRendering({ sourceRoot, outputRoot: path.join(sourceRoot, 'prepared') }), /original source cache/);
        await assert.rejects(prepareDiagnosticRendering({ sourceRoot, outputRoot: path.join(defaultAdditionalSourceRoot, 'prepared') }), /supplemental original cache/);
        await assert.rejects(prepareDiagnosticRendering({ sourceRoot, outputRoot: path.join(root, 'prepared'), referenceCache: path.join(root, 'missing-reference') }), { code: 'ENOENT' });
        assert(defaultReferenceCache.startsWith(path.join(repository, 'out') + path.sep));
    } finally { await rm(root, { recursive: true, force: true }); }
});
