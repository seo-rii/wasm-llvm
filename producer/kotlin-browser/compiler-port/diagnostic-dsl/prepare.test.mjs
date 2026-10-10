import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { defaultDiagnosticDslReference, DSL_PATH, prepareDiagnosticDsl, prepareDiagnosticDslReferences, splitDiagnosticDsl, verifyDiagnosticDsl } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const lock = JSON.parse(await readFile(path.join(here, 'sources.lock.json')));
async function fixture(run) {
    const temp = await mkdtemp(path.join(repository, 'out/diagnostic-dsl-integrity-'));
    try {
        const sourceRoot = path.join(temp, 'sources'); await cp(defaultDiagnosticDslReference, sourceRoot, { recursive: true });
        await run({ temp, sourceRoot, outputRoot: path.join(temp, 'output') });
    } finally { await rm(temp, { recursive: true, force: true }); }
}

test('split preserves every source-free declaration byte and real delegate initialization', async () => fixture(async options => {
    const original = await readFile(path.join(options.sourceRoot, DSL_PATH));
    const prepared = await prepareDiagnosticDsl(options);
    const verified = await verifyDiagnosticDsl(path.dirname(prepared.receiptPath));
    const common = await readFile(prepared.commonSources[0]);
    assert(common.equals(splitDiagnosticDsl(original, lock)));
    for (const part of lock.split.declarations) assert(common.includes(original.subarray(part.start, part.end)));
    assert(common.toString().includes('DummyDelegate(KtSourcelessDiagnosticFactory(prop.name, severity, container.getRendererFactory()))'));
    assert(!/PsiElement|KClass|psiType|LanguageFeature/.test(common.toString()));
    assert.equal(verified.receipt.split.declarations.length, 5);
    assert.equal(verified.receipt.files.length, 3);
}));

test('corrupt DSL or Gradle provenance prevents output publication', async () => fixture(async options => {
    for (const pin of lock.files) {
        const target = path.join(options.sourceRoot, pin.path); const bytes = await readFile(target);
        await writeFile(target, Buffer.concat([bytes, Buffer.from('// changed')]));
        await assert.rejects(prepareDiagnosticDsl(options)); await writeFile(target, bytes);
    }
    const prepared = await prepareDiagnosticDsl(options);
    await writeFile(prepared.commonSources[0], 'changed');
    await assert.rejects(verifyDiagnosticDsl(path.dirname(prepared.receiptPath)));
}));

test('receipt rejects altered declaration inventory, provenance or completion claims', async () => fixture(async options => {
    const prepared = await prepareDiagnosticDsl(options);
    const receipt = JSON.parse(await readFile(prepared.receiptPath));
    for (const changes of [{ split: { ...receipt.split, declarations: [] } }, { prepareToolSha256: '0'.repeat(64) },
        { declarationBodiesChanged: true }, { sourceBearingDslIncluded: true }, { runtime: 'pass' },
        { replacedOriginalPaths: [DSL_PATH] }, { fullCompilerAcceptance: true }]) {
        await writeFile(prepared.receiptPath, JSON.stringify({ ...receipt, ...changes }));
        await assert.rejects(verifyDiagnosticDsl(path.dirname(prepared.receiptPath)));
    }
    await writeFile(prepared.receiptPath, JSON.stringify(receipt)); await verifyDiagnosticDsl(path.dirname(prepared.receiptPath));
}));

test('source/output overlap, reused output and symlinked source reject without overwrite', async () => fixture(async options => {
    for (const outputRoot of [options.sourceRoot, path.join(options.sourceRoot, 'nested'), options.temp]) {
        await assert.rejects(prepareDiagnosticDsl({ ...options, outputRoot }));
    }
    const prepared = await prepareDiagnosticDsl(options);
    await assert.rejects(prepareDiagnosticDsl(options)); await verifyDiagnosticDsl(path.dirname(prepared.receiptPath));
    const target = path.join(options.sourceRoot, DSL_PATH); const destination = path.join(options.temp, 'original.kt');
    await writeFile(destination, await readFile(target)); await rm(target); await symlink(destination, target);
    await assert.rejects(prepareDiagnosticDsl({ ...options, outputRoot: path.join(options.temp, 'second') }));
}));

test('fresh references use exact locked URLs and corrupt caches cannot silently refetch', async () => fixture(async options => {
    const requests = [];
    const reference = await prepareDiagnosticDslReferences({ sourceRoot: path.join(options.temp, 'fresh'), fetcher: async url => {
        requests.push(url);
        const pin = lock.files.find(pin => url === `https://raw.githubusercontent.com/JetBrains/kotlin/${lock.source.commit}/${pin.path}`);
        assert(pin); return new Response(await readFile(path.join(options.sourceRoot, pin.path)));
    } });
    assert.equal(requests.length, 2); await prepareDiagnosticDsl({ sourceRoot: reference.sourceRoot, outputRoot: options.outputRoot });
    await writeFile(path.join(options.sourceRoot, DSL_PATH), 'corrupt');
    await assert.rejects(prepareDiagnosticDslReferences({ sourceRoot: options.sourceRoot, fetcher: () => { throw new Error('must not fetch'); } }));
}));

test('oversized or mismatched network bytes are rejected before caching', async () => fixture(async options => {
    for (const payload of [Buffer.alloc(lock.files[0].bytes + 1), Buffer.alloc(lock.files[0].bytes)]) {
        await assert.rejects(prepareDiagnosticDslReferences({ sourceRoot: path.join(options.temp, 'fresh'), fetcher: async () => new Response(payload) }));
    }
}));
