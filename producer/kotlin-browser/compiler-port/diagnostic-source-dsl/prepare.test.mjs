import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sha256 } from '../../scripts/source.mjs';
import { defaultDiagnosticDslReference } from '../diagnostic-dsl/prepare.mjs';
import { guardSourceDslCallers, prepareDiagnosticSourceDsl, verifyDiagnosticSourceDsl } from './prepare.mjs';
import { transformDiagnosticContainer, transformSourceDsl } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const lock = JSON.parse(await readFile(path.join(here, 'sources.lock.json')));
const sourceFree = JSON.parse(await readFile(path.join(here, '../diagnostic-dsl/sources.lock.json')));
const snapshotPin = (logical, bytes) => ({ path: logical, bytes: bytes.length, sha256: sha256(bytes), source: bytes.toString('base64') });
async function fixture(run) {
    const temp = await mkdtemp(path.join(repository, 'out/diagnostic-source-dsl-integrity-'));
    try {
        const sourceRoot = path.join(temp, 'sources'), referenceRoot = path.join(temp, 'reference'), retainedSources = [];
        for (const [from, to, pins] of [[defaultDiagnosticDslReference, referenceRoot, lock.referenceFiles],
            [path.join(repository, 'out/kotlin-compiler-port/sources'), sourceRoot, lock.containers]]) {
            for (const pin of pins) {
                const bytes = await readFile(path.join(from, pin.path)), filename = path.join(to, pin.path);
                await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes);
                if (to === sourceRoot) retainedSources.push({ path: pin.path, filename, bytes: bytes.length, sha256: sha256(bytes) });
            }
        }
        await run({ temp, sourceRoot, referenceRoot, retainedSources, outputRoot: path.join(temp, 'output') });
    } finally { await rm(temp, { recursive: true, force: true }); }
}

test('all seven outputs preserve exact delegate/body bytes outside recorded metadata spans', async () => fixture(async options => {
    const prepared = await prepareDiagnosticSourceDsl(options); const checked = await verifyDiagnosticSourceDsl(path.dirname(prepared.receiptPath));
    assert.equal(prepared.commonSources.length, 7); assert.equal(prepared.replacedOriginalPaths.length, 6);
    assert.equal(checked.receipt.metadataTypeArgumentSites, 31); assert.equal(checked.receipt.metadataBindingCount, 34);
    assert.equal(checked.receipt.outputs[0].deletions.length, 61);
    for (const pin of checked.receipt.outputs) {
        const code = await readFile(path.join(path.dirname(prepared.receiptPath), pin.path), 'utf8');
        assert(!/\b(?:PsiElement|psiType|KClass)\b/.test(code));
        assert(code.includes('getRendererFactory()'));
    }
    const wasm = checked.receipt.outputs.find(pin => pin.path.endsWith('/WasmKlibErrors.kt'));
    assert.equal(wasm.bindings.length, 4); assert.equal(wasm.deletions.length, 2);
}));

test('unknown body PSI uses and changed typed helper grammar fail closed', async () => fixture(async options => {
    const table = await readFile(options.retainedSources[0].filename, 'utf8');
    assert.throws(() => transformDiagnosticContainer(table + '\nfun extra(x: PsiElement) = x\n', 6), /outside diagnostic metadata/);
    const dsl = await readFile(path.join(options.referenceRoot, lock.referenceFiles[0].path), 'utf8');
    assert.throws(() => transformSourceDsl(dsl.replace('P::class, container', 'container, P::class'), sourceFree));
    await writeFile(options.retainedSources[0].filename, table.replace('IrFunction', 'Any'));
    await assert.rejects(prepareDiagnosticSourceDsl(options), /Pinned source content mismatch/);
}));

test('all actual callers are required and unknown/aliased/comment callers are rejected', async () => fixture(async options => {
    const snapshot = [], originals = new Map();
    for (const pin of options.retainedSources) {
        const bytes = await readFile(pin.filename); originals.set(pin.path, bytes); snapshot.push(snapshotPin(pin.path, bytes));
    }
    assert.equal(guardSourceDslCallers(snapshot, lock, originals).diagnostics, 31);
    assert.throws(() => guardSourceDslCallers(snapshot.slice(1), lock, originals), /Missing retained/);
    for (const text of ['val EXTRA by error1<PsiElement, String>()', 'import org.jetbrains.kotlin.diagnostics.error0 as fail\nval X by fail<PsiElement>()', '// warning1<String>() needs review']) {
        assert.throws(() => guardSourceDslCallers([...snapshot, snapshotPin('entry/Unknown.kt', Buffer.from(text))], lock, originals));
    }
}));

test('prior selected container body changes cannot be silently replaced when counts stay equal', async () => fixture(async options => {
    const originals = new Map(), snapshot = [];
    for (const pin of options.retainedSources) {
        const bytes = await readFile(pin.filename); originals.set(pin.path, bytes); snapshot.push(snapshotPin(pin.path, bytes));
    }
    const first = snapshot[0];
    const changed = Buffer.concat([originals.get(first.path), Buffer.from('\nprivate fun priorAlgorithmChange() = "changed"\n')]);
    snapshot[0] = snapshotPin(first.path, changed);
    assert.throws(() => guardSourceDslCallers(snapshot, lock, originals), /Selected diagnostic container body changed/);
    const importsOnly = originals.get(first.path).toString().replace(/(^package[^\n]+)\n/m, '$1\n\n\nimport kotlin.jvm.*\n');
    snapshot[0] = snapshotPin(first.path, Buffer.from(importsOnly));
    assert.equal(guardSourceDslCallers(snapshot, lock, originals).diagnostics, 31);
}));

test('receipt/output/snapshot changes and false runtime claims cannot reuse evidence', async () => fixture(async options => {
    const prepared = await prepareDiagnosticSourceDsl(options), root = path.dirname(prepared.receiptPath);
    const receipt = JSON.parse(await readFile(prepared.receiptPath));
    for (const changes of [{ metadataBindingCount: 0 }, { outputs: [] }, { sourceFreeDeclarationsIncluded: true },
        { diagnosticBodiesChanged: true }, { diagnosticRuntime: 'pass' }, { wasmRuntime: 'pass' }, { languageReadiness: true }, { fullCompilerAcceptance: true }]) {
        await writeFile(prepared.receiptPath, JSON.stringify({ ...receipt, ...changes })); await assert.rejects(verifyDiagnosticSourceDsl(root));
    }
    await writeFile(prepared.receiptPath, JSON.stringify(receipt)); await verifyDiagnosticSourceDsl(root);
    await writeFile(prepared.commonSources[0], 'changed'); await assert.rejects(verifyDiagnosticSourceDsl(root));
}));

test('source/reference/output overlap, symlinked inputs and reused publication reject', async () => fixture(async options => {
    for (const outputRoot of [options.sourceRoot, path.join(options.sourceRoot, 'nested'), options.temp, options.referenceRoot])
        await assert.rejects(prepareDiagnosticSourceDsl({ ...options, outputRoot }), /overlap/);
    await prepareDiagnosticSourceDsl(options); await assert.rejects(prepareDiagnosticSourceDsl(options), /EEXIST/);
    const target = options.retainedSources[0].filename, real = path.join(options.temp, 'original.kt');
    await writeFile(real, await readFile(target)); await rm(target); await symlink(real, target);
    await assert.rejects(prepareDiagnosticSourceDsl({ ...options, outputRoot: path.join(options.temp, 'second') }), /Symlink/);
}));
