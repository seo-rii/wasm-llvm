import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../scripts/source.mjs';
import { prepareParserProfileSourceCache } from './fetch.mjs';
import { prepareParserProfileSources } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const recipe = JSON.parse(await readFile(path.join(here, 'parser-profile.recipe.json'), 'utf8'));
const canonical = path.join(repository, 'out/kotlin-compiler-port/sources');
const cached = await prepareParserProfileSourceCache();

async function fixture(t, copied = false) {
    const root = await mkdtemp(path.join(repository, 'out/kotlin-parser-profile-integrity-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourceRoot = copied ? path.join(root, 'sources') : canonical;
    if (copied) await cp(canonical, sourceRoot, { recursive: true });
    return { root, sourceRoot, outputRoot: path.join(root, 'output'), supplementalSourceRoot: cached.supplementalSourceRoot };
}

test('new-parser source profile retains all shared algorithms, resolution body, registration and diagnostics', async (t) => {
    const f = await fixture(t);
    const before = new Map(await Promise.all(recipe.originals.map(async (pin) => [pin.path, await readFile(path.join(canonical, pin.path))])));
    const prepared = await prepareParserProfileSources(f);
    assert.equal(prepared.commonSources.length, 4);
    assert.equal(prepared.replacedOriginalPaths.length, 3);
    assert.equal(prepared.sourceSetExclusions.length, 5);
    assert.equal(prepared.receipt.retainedSharedSources.length, 17);
    assert.equal(prepared.receipt.retainedNewParserSources.length, 4);
    for (const pin of recipe.retainedSharedSources) assert(!prepared.sourceSetExclusions.includes(pin.path));
    const firFile = prepared.commonSources.find((file) => file.endsWith('/firUtils.kt'));
    const fir = await readFile(firFile, 'utf8');
    const resolution = recipe.declarations.find((item) => item.name === 'resolveAndCheckFir');
    const originalFir = before.get(resolution.sourcePath).toString('utf8');
    const body = originalFir.slice(resolution.startUtf16, resolution.endUtf16);
    assert.equal(sha256(Buffer.from(body)), resolution.sha256);
    assert(fir.includes(body));
    assert(fir.includes('MultiplatformParsing2Fir(this, firProvider.kotlinScopeProvider, diagnosticsReporter)'));
    assert(fir.indexOf('requireMultiplatformParser(useMultiplatformParsing)') < fir.indexOf('val firProvider ='));
    assert(fir.includes('useMultiplatformParsing = true'));
    assert(!fir.includes('LightTree2Fir(') && !fir.includes('PsiRawFirBuilder') && !fir.includes('getContentsAsStream'));
    assert(fir.includes('code.toSourceLinesMapping()') && fir.includes('firProvider.recordFile(firFile)'));
    const jvmReference = await readFile(path.join(path.dirname(prepared.receiptPath), 'JvmFirConvenience.kt.reference'), 'utf8');
    const omitted = recipe.declarations.find((item) => item.role === 'jvm-only-reference');
    assert(jvmReference.includes(originalFir.slice(omitted.startUtf16, omitted.endUtf16)));
    assert.equal(prepared.receipt.syntaxDiagnosticHostPatchUnmodified, true);
    assert.equal(prepared.receipt.resolvedFirExecution, 'not-run');
    assert.equal(prepared.receipt.languageReadiness, false);
    for (const pin of recipe.originals) assert.deepEqual(await readFile(path.join(canonical, pin.path)), before.get(pin.path));
});

test('oversized audited source rejects before receipt or portable-source publication', async (t) => {
    const f = await fixture(t, true);
    const pin = recipe.originals.find((item) => item.path.endsWith('/ConverterUtil.kt'));
    await writeFile(path.join(f.sourceRoot, pin.path), Buffer.alloc(pin.bytes + 1));
    await assert.rejects(prepareParserProfileSources(f), /bounded regular file/);
    await assert.rejects(readFile(path.join(f.outputRoot, 'compiler-port-parser-profile/parser-profile-inputs.json')), { code: 'ENOENT' });
});

test('changed selected caller source cannot bypass the exact original identity and exclusion audit', async (t) => {
    const f = await fixture(t, true);
    const pin = recipe.originals.find((item) => item.path.endsWith('/firUtils.kt'));
    const bytes = await readFile(path.join(f.sourceRoot, pin.path));
    bytes[0] ^= 1;
    await writeFile(path.join(f.sourceRoot, pin.path), bytes);
    await assert.rejects(prepareParserProfileSources(f), /Pinned source content mismatch/);
});

test('symlinked audited source or supplemental PSI source is rejected', async (t) => {
    const f = await fixture(t, true);
    const pin = recipe.originals.find((item) => item.path.endsWith('/WhenEntry.kt'));
    const target = path.join(f.sourceRoot, pin.path);
    await rm(target); await symlink(path.join(canonical, pin.path), target);
    await assert.rejects(prepareParserProfileSources(f), /Symlink paths are not accepted/);
    const supplementalSourceRoot = path.join(f.root, 'linked-supplemental');
    await symlink(cached.supplementalSourceRoot, supplementalSourceRoot);
    await assert.rejects(prepareParserProfileSources({ ...f, sourceRoot: canonical, supplementalSourceRoot }), /Symlink paths are not accepted/);
});

test('output symlinks, source-cache descendants and existing output are preserved and rejected', async (t) => {
    const f = await fixture(t);
    await symlink(canonical, f.outputRoot);
    await assert.rejects(prepareParserProfileSources(f), /Symlink paths are not accepted/);
    await assert.rejects(prepareParserProfileSources({ ...f, outputRoot: path.join(canonical, 'new-output') }), /Do not modify the original source cache/);
    await rm(f.outputRoot);
    const root = path.join(f.outputRoot, 'compiler-port-parser-profile');
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'keep.txt'), 'existing output');
    await assert.rejects(prepareParserProfileSources(f), { code: 'EEXIST' });
    assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'existing output');
    await assert.rejects(readFile(path.join(root, 'parser-profile-inputs.json')), { code: 'ENOENT' });
});
