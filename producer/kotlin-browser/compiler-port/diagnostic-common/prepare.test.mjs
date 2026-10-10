import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareDiagnosticCommon, prepareDiagnosticCommonReferences, verifyDiagnosticCommon } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const cache = path.join(repository, 'out/kotlin-diagnostic-common-reference/sources');
const lock = JSON.parse(await readFile(path.join(here, 'sources.lock.json')));
async function fixture(run) {
    const temp = await mkdtemp(path.join(repository, 'out/diagnostic-common-integrity-'));
    try {
        const sourceRoot = path.join(temp, 'sources'); await cp(cache, sourceRoot, { recursive: true });
        await run({ temp, sourceRoot, outputRoot: path.join(temp, 'output') });
    } finally { await rm(temp, { recursive: true, force: true }); }
}
test('retains all renderer and generated feature bodies except exact Throwable host binding', async () => fixture(async options => {
    const prepared = await prepareDiagnosticCommon(options);
    const checked = await verifyDiagnosticCommon(path.dirname(prepared.receiptPath));
    assert.equal(checked.receipt.files.length, 6);
    const generated = prepared.commonSources.find(file => file.includes('FeatureToFlagMapGenerated'));
    assert((await readFile(generated)).equals(await readFile(path.join(options.sourceRoot, lock.files[2].path))));
    const common = (await readFile(prepared.commonSources[0])).toString();
    assert(common.includes('val THROWABLE')); assert(common.includes('renderConflictingSignatureData'));
    assert(common.includes('stackTrace.substring(0, 2048) + "..."'));
}));
test('changed original and generated source reject publication and re-verification', async () => fixture(async options => {
    const prepared = await prepareDiagnosticCommon(options);
    await writeFile(prepared.commonSources[0], 'changed');
    await assert.rejects(verifyDiagnosticCommon(path.dirname(prepared.receiptPath)));
    await writeFile(path.join(options.sourceRoot, lock.files[0].path), 'changed');
    await assert.rejects(prepareDiagnosticCommon({ ...options, outputRoot: path.join(options.temp, 'second') }));
}));
test('cache/output overlap, existing output and symlinked input are rejected', async () => fixture(async options => {
    for (const outputRoot of [options.sourceRoot, path.join(options.sourceRoot, 'nested'), options.temp]) {
        await assert.rejects(prepareDiagnosticCommon({ ...options, outputRoot }));
    }
    const prepared = await prepareDiagnosticCommon(options);
    await assert.rejects(prepareDiagnosticCommon(options));
    await verifyDiagnosticCommon(path.dirname(prepared.receiptPath));
    const target = path.join(options.sourceRoot, lock.files[0].path);
    const content = await readFile(target); const replacement = path.join(options.temp, 'original.kt');
    await writeFile(replacement, content); await rm(target); await symlink(replacement, target);
    await assert.rejects(prepareDiagnosticCommon({ ...options, outputRoot: path.join(options.temp, 'symlink') }));
}));
test('receipt cannot claim omitted declarations or unexecuted acceptance', async () => fixture(async options => {
    const prepared = await prepareDiagnosticCommon(options);
    const receipt = JSON.parse(await readFile(prepared.receiptPath));
    for (const changes of [{ fullCompilerAcceptance: true }, { fullRendererExecution: 'pass' },
        { diagnosticDeclarationsRemoved: true }, { languageFeatureMappingsRemoved: true }, { commonPaths: [] }]) {
        await writeFile(prepared.receiptPath, JSON.stringify({ ...receipt, ...changes }));
        await assert.rejects(verifyDiagnosticCommon(path.dirname(prepared.receiptPath)));
    }
    await writeFile(prepared.receiptPath, JSON.stringify(receipt));
    await verifyDiagnosticCommon(path.dirname(prepared.receiptPath));
}));
test('reference fetch is exact commit-bound and corrupt cache is never repaired silently', async () => fixture(async options => {
    const requests = [];
    await prepareDiagnosticCommonReferences({ sourceRoot: path.join(options.temp, 'download'), fetcher: async url => {
        requests.push(url);
        const pin = lock.files.find(pin => url === `https://raw.githubusercontent.com/JetBrains/kotlin/${lock.source.commit}/${pin.path}`);
        assert(pin); return new Response(await readFile(path.join(options.sourceRoot, pin.path)));
    } });
    assert.equal(requests.length, 3);
    await writeFile(path.join(options.sourceRoot, lock.files[0].path), 'corrupt');
    await assert.rejects(prepareDiagnosticCommonReferences({ sourceRoot: options.sourceRoot, fetcher: () => { throw new Error('must not fetch'); } }));
}));
