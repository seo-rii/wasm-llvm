import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sha256 } from '../../scripts/source.mjs';
import { CLI_CONFIGURATION, CLI_REPORTING, CLI_KEYS, WEB_FACTORY, WEB_MODULE } from './generate.mjs';
import { prepareSourceClosure, prepareSourceClosureReferences, verifySourceClosure } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); const REPO = path.resolve(HERE, '../../../..');
const cache = path.join(REPO, 'out/kotlin-source-closure-reference/sources');
const lock = JSON.parse(await readFile(path.join(HERE, 'sources.lock.json')));
async function fixture(run) {
    const root = await mkdtemp(path.join(REPO, 'out/kotlin-source-closure-guard-'));
    try {
        const sourceRoot = path.join(root, 'sources'); await cp(cache, sourceRoot, { recursive: true });
        await run({ root, sourceRoot, outputRoot: path.join(root, 'output') });
    } finally { await rm(root, { recursive: true, force: true }); }
}

test('Actual web-common module and selected CLI declarations retain pinned algorithms', async () => fixture(async f => {
    const prepared = await prepareSourceClosure(f); const checked = await verifySourceClosure(path.dirname(prepared.receiptPath));
    assert.equal(checked.commonSources.length, 19); assert.equal(checked.receipt.webCommonKotlinFiles, 16);
    assert.equal(checked.receipt.webCommonDiagnosticDeclarations, 30); assert.equal(checked.receipt.languageReadiness, false);
    assert.deepEqual(checked.receipt.excludedCheckerFiles, []);
    for (const pin of lock.files.filter(pin => pin.compile && pin.path !== WEB_FACTORY)) {
        assert.equal(sha256(await readFile(path.join(path.dirname(prepared.receiptPath), pin.path))), pin.sha256);
    }
    const factory = await readFile(path.join(path.dirname(prepared.receiptPath), WEB_FACTORY), 'utf8');
    assert.equal([...factory.matchAll(/^    val /gm)].length, 30); assert(!factory.includes('::class'));
    const reference = JSON.parse(await readFile(path.join(path.dirname(prepared.receiptPath), 'web-common-psi-bindings.reference.json')));
    assert.equal(reference.length, 30);
    const configuration = await readFile(path.join(path.dirname(prepared.receiptPath), CLI_CONFIGURATION), 'utf8');
    for (const [key, property] of CLI_KEYS) assert(configuration.includes(key) && configuration.includes('CompilerConfiguration.' + property));
    assert(configuration.includes('error("diagnostic collector is not initialized")'));
    const originalReport = await readFile(path.join(f.sourceRoot, CLI_REPORTING), 'utf8');
    const report = await readFile(path.join(path.dirname(prepared.receiptPath), CLI_REPORTING), 'utf8');
    const body = report.slice(report.indexOf('fun CompilerConfiguration.report(')).trimEnd();
    assert(originalReport.includes(body)); assert(report.includes('diagnosticsCollector.report(factory, message, location)'));
    for (const pin of lock.files) assert.equal(sha256(await readFile(path.join(f.sourceRoot, pin.path))), pin.sha256);
}));

test('Corrupt official checker source cannot publish a preparation receipt', async () => fixture(async f => {
    const pin = lock.files.find(pin => pin.path.startsWith(WEB_MODULE + '/src/') && pin.compile);
    const file = path.join(f.sourceRoot, pin.path); const changed = await readFile(file); changed[100] ^= 1; await writeFile(file, changed);
    await assert.rejects(prepareSourceClosure(f), /Pinned source content mismatch/);
    await assert.rejects(readFile(path.join(f.outputRoot, 'compiler-port-source-closure/receipt.json')), { code: 'ENOENT' });
}));

test('Completed source outputs and receipts survive a rejected repeated preparation', async () => fixture(async f => {
    const prepared = await prepareSourceClosure(f); const before = await readFile(prepared.receiptPath);
    await assert.rejects(prepareSourceClosure(f), { code: 'EEXIST' }); assert.deepEqual(await readFile(prepared.receiptPath), before);
    await verifySourceClosure(path.dirname(prepared.receiptPath));
}));

test('Source overlap and symlinks cannot write inside the original cache', async () => fixture(async f => {
    const before = await readdir(f.sourceRoot);
    await assert.rejects(prepareSourceClosure({ ...f, outputRoot: path.join(f.sourceRoot, 'generated') }), /overlaps original/);
    assert.deepEqual(await readdir(f.sourceRoot), before);
    const link = path.join(f.root, 'source-link'); await symlink(f.sourceRoot, link);
    await assert.rejects(prepareSourceClosure({ ...f, sourceRoot: link }), /Symlink paths/);
    await symlink(f.root, f.outputRoot); await assert.rejects(prepareSourceClosure(f), /Symlink paths/);
}));

test('Prepared checker bytes and false readiness cannot be relabeled', async () => fixture(async f => {
    const prepared = await prepareSourceClosure(f); const root = path.dirname(prepared.receiptPath);
    const file = prepared.commonSources.find(file => file.includes('/checkers/declaration/'));
    const before = await readFile(file); await writeFile(file, Buffer.concat([before, Buffer.from('\nchanged\n')]));
    await assert.rejects(verifySourceClosure(root), /Supplemental compiler source changed/); await writeFile(file, before);
    const receipt = await readFile(prepared.receiptPath); const changed = JSON.parse(receipt); changed.languageReadiness = true;
    await writeFile(prepared.receiptPath, JSON.stringify(changed)); await assert.rejects(verifySourceClosure(root), /Stale supplemental source receipt/);
}));

test('Fresh original source fetch is exact-commit bound and includes the actual dependency version property', async () => fixture(async f => {
    const urls = []; const outputRoot = path.join(f.root, 'fresh-references');
    const prefix = 'https://raw.githubusercontent.com/JetBrains/kotlin/' + lock.source.commit + '/';
    const references = await prepareSourceClosureReferences({ outputRoot, fetcher: async url => {
        urls.push(url); assert(url.startsWith(prefix));
        const filename = decodeURIComponent(url.slice(prefix.length)); assert(lock.files.some(pin => pin.path === filename));
        return new Response(await readFile(path.join(f.sourceRoot, filename)));
    } });
    assert.equal(urls.length, 23); assert.equal(references.receipt.files.length, 23);
    assert(urls.some(url => url.endsWith('/gradle/versions.properties')));
    const repeated = await prepareSourceClosureReferences({ outputRoot, fetcher: () => { throw new Error('Unexpected repeated network request'); } });
    assert.deepEqual(repeated.receipt, references.receipt);
    const file = path.join(references.sourceRoot, WEB_FACTORY); const changed = await readFile(file); changed[100] ^= 1; await writeFile(file, changed);
    await assert.rejects(prepareSourceClosureReferences({ outputRoot }), /Pinned source content mismatch/);
}));

test('Wrong downloaded source bytes cannot publish an original-source success receipt', async () => fixture(async f => {
    const outputRoot = path.join(f.root, 'invalid-references');
    await assert.rejects(prepareSourceClosureReferences({ outputRoot, fetcher: async url => {
        const filename = url.split(lock.source.commit + '/')[1]; const changed = await readFile(path.join(f.sourceRoot, filename)); changed[100] ^= 1;
        return new Response(changed);
    } }), /Pinned source content mismatch/);
    await assert.rejects(readFile(path.join(outputRoot, 'source-references.json')), { code: 'ENOENT' });
}));
