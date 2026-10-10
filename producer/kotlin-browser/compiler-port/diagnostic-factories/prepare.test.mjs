import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareDiagnosticFactories } from './prepare.mjs';
import { transformFactorySource, transformGeneratedDiagnostics } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const recipe = JSON.parse(await readFile(path.join(here, 'diagnostic-factories.recipe.json'), 'utf8'));
const canonical = path.join(repository, 'out/kotlin-compiler-port/sources');
const originals = new Map(await Promise.all(recipe.originals.map(async (pin) => [pin.path, await readFile(path.join(canonical, pin.path))])));

async function fixture(t, copied = false) {
    const root = await mkdtemp(path.join(repository, 'out/kotlin-diagnostic-factories-integrity-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourceRoot = copied ? path.join(root, 'sources') : canonical;
    if (copied) for (const [relative, bytes] of originals) {
        const filename = path.join(sourceRoot, relative);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, bytes, { flag: 'wx' });
    }
    return { sourceRoot, outputRoot: path.join(root, 'output'), root };
}

function reconstruct(original, result) {
    let reconstructed = '', consumed = 0, removed = 0;
    for (const deletion of result.deletions) {
        const kept = deletion.startUtf16 - consumed;
        reconstructed += result.text.slice(consumed - removed, consumed - removed + kept);
        reconstructed += original.slice(deletion.startUtf16, deletion.endUtf16);
        consumed = deletion.endUtf16;
        removed += deletion.endUtf16 - deletion.startUtf16;
    }
    return reconstructed + result.text.slice(consumed - removed);
}

test('only recorded metadata bytes change; all 969 declarations and actual factory algorithms reconstruct exactly', async () => {
    let count = 0;
    for (const output of recipe.outputs) {
        const original = originals.get(output.originalPath).toString('utf8');
        const result = output.kind === 'factory' ? transformFactorySource(original) : transformGeneratedDiagnostics(original, output.table, output.diagnostics);
        assert.equal(reconstruct(original, result), original);
        if (output.kind === 'generated') {
            count += result.bindings.length;
            const names = (text) => [...text.matchAll(/^    val ([A-Z0-9_]+): (.+?) =/gm)].map((match) => [match[1], match[2]]);
            assert.deepEqual(names(result.text), names(original));
        } else {
            assert(!result.text.includes('psiType') && !result.text.includes('KClass'));
            assert.equal([...result.text.matchAll(/fun onOrFallback\(/g)].length, 5);
            assert.equal([...result.text.matchAll(/fun on\(/g)].length, 5);
        }
    }
    assert.equal(count, 969);
});

test('unexpected constructor forms, metadata readers and genuine PSI typed parameters reject transformation', () => {
    const factory = originals.get(recipe.outputs.find((item) => item.kind === 'factory').originalPath).toString('utf8');
    assert.throws(() => transformFactorySource(factory.replace('    psiType: KClass<*>,', '    psiType: KClass<out String>,')), /constructor metadata form/);
    assert.throws(() => transformFactorySource(factory.replace('return name', 'return psiType.toString()')), /remaining diagnostic metadata reference/);
    const syntax = originals.get(recipe.outputs.find((item) => item.table === 'syntax').originalPath).toString('utf8');
    assert.throws(() => transformGeneratedDiagnostics(syntax.replace('PsiElement::class', 'Any::class'), 'syntax', 3), /Unbound PSI metadata/);
    assert.throws(() => transformGeneratedDiagnostics(syntax.replace('PsiElement::class', 'psiType = PsiElement::class'), 'syntax', 3), /constructor form/);
    assert.throws(() => transformGeneratedDiagnostics(syntax.replace('KtDiagnosticFactory1<String>', 'KtDiagnosticFactory1<PsiElement>'), 'syntax', 3), /genuine diagnostic parameter/);
});

test('preparation emits four real source variants, no excluded checkers and complete PSI binding provenance', async (t) => {
    const f = await fixture(t);
    const prepared = await prepareDiagnosticFactories(f);
    assert.equal(prepared.commonSources.length, 4);
    assert.equal(prepared.replacedOriginalPaths.length, 4);
    assert.deepEqual(prepared.sourceSetExclusions, []);
    assert.equal(prepared.receipt.diagnosticDeclarations, 969);
    assert.equal(prepared.receipt.callerAudit.unexpectedMetadataReaders, 0);
    assert.equal(prepared.receipt.callerAudit.unexpectedConstructorCallers, 0);
    assert.equal(prepared.receipt.diagnosticRuntime, 'not-run');
    assert.equal(prepared.receipt.wasmRuntime, 'not-run');
    const ledger = JSON.parse(await readFile(path.join(path.dirname(prepared.receiptPath), 'jvm-psi-class-bindings.json'), 'utf8'));
    assert.equal(ledger.length, 969);
    assert(ledger.every((item) => /^(com\.intellij\.psi|org\.jetbrains\.kotlin\.psi)\./.test(item.psiClass)));
    for (const [relative, bytes] of originals) assert.deepEqual(await readFile(path.join(canonical, relative)), bytes);
});

test('oversized input and same-sized alteration reject before success receipt publication', async (t) => {
    const f = await fixture(t, true);
    const pin = recipe.originals[0];
    const filename = path.join(f.sourceRoot, pin.path);
    await writeFile(filename, Buffer.alloc(pin.bytes + 1));
    await assert.rejects(prepareDiagnosticFactories(f), /bounded regular file/);
    const changed = Buffer.from(originals.get(pin.path)); changed[0] ^= 1;
    await writeFile(filename, changed);
    await assert.rejects(prepareDiagnosticFactories(f), /Pinned source content mismatch/);
    await assert.rejects(readFile(path.join(f.outputRoot, 'compiler-port-diagnostic-factories/diagnostic-factory-inputs.json')), { code: 'ENOENT' });
});

test('symlinked source/output and source-cache descendants reject without mutation', async (t) => {
    const f = await fixture(t, true);
    const pin = recipe.originals[0]; const filename = path.join(f.sourceRoot, pin.path);
    await rm(filename); await symlink(path.join(canonical, pin.path), filename);
    await assert.rejects(prepareDiagnosticFactories(f), /Symlink paths are not accepted/);
    await symlink(canonical, f.outputRoot);
    await assert.rejects(prepareDiagnosticFactories({ ...f, sourceRoot: canonical }), /Symlink paths are not accepted/);
    await assert.rejects(prepareDiagnosticFactories({ ...f, sourceRoot: canonical, outputRoot: path.join(canonical, 'new-output') }), /Do not modify the original source cache/);
});
