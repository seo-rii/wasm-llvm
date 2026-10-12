import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { sha256, writeJson } from '../../scripts/source.mjs';
import { TARGETS, REGISTRIES, HOST, SYMBOLS, checkerReferences, checkerChanges, applyCheckerChanges } from './transform.mjs';
import { verifyFirLightTreeSemanticCheckerFinalSources } from './prepare.mjs';

test('checker names remain visible through aliases, escapes and literal/interpolation forms', () => {
    for (const name of SYMBOLS) for (const source of ['import p.' + name + ' as Alias', 'val x=p.`' + name + '`', 'val x="' + name.slice(0, 12) + '" + "' + name.slice(12) + '"', 'val x="${' + name + '}"', 'val x="' + name.slice(0, -1) + '\\u' + name.at(-1).charCodeAt(0).toString(16).padStart(4, '0') + '"'])
        assert(checkerReferences(source).includes(name), source);
    assert.deepEqual(checkerReferences('object OtherChecker {}'), []);
});

test('thirteen exact spans preserve import boundaries and complete byte inverses', async () => {
    const lock = JSON.parse(await readFile(new URL('./sources.lock.json', import.meta.url))), fixture = process.env.FIR_SEMANTIC_FIXTURE;
    assert.equal(Object.values(lock.changes).reduce((n, rows) => n + rows.length, 0), 13);
    for (const logical of TARGETS) {
        const bytes = fixture ? await readFile(path.join(JSON.parse(await readFile(fixture, 'utf8')).options.outputRoot, 'original', logical)) : await readFile(path.resolve('out/kotlin-compiler-port/sources', logical));
        assert.deepEqual(checkerChanges(logical, bytes), lock.changes[logical]); const after = applyCheckerChanges(bytes, lock.changes[logical]);
        assert.deepEqual(applyCheckerChanges(after, lock.changes[logical], true), bytes);
        assert(!/\*\/import\b/.test(after.toString()));
    }
});

test('actual two-file public final preserves complete rows and rejects precise malformed inputs', { skip: !process.env.FIR_SEMANTIC_FIXTURE }, async () => {
    const f = JSON.parse(await readFile(process.env.FIR_SEMANTIC_FIXTURE, 'utf8')), rows = f.rows, baseOptions = { ...f.options, retainedSources: rows }, records = [];
    const call = changes => verifyFirLightTreeSemanticCheckerFinalSources(changes ? { ...baseOptions, ...changes } : baseOptions);
    async function rejects(name, run, reason) {
        let error; try { await run(); } catch (caught) { error = caught; }
        assert(error, 'Negative accepted: ' + name); assert.equal(error.code, 'ERR_ASSERTION', 'Guard must fail by contract: ' + name);
        assert(reason.test(error.message), 'Wrong failure reason: ' + name + ': ' + error.message); assert(!/ENOENT|EEXIST/.test(error.message));
        records.push({ name, error: { name: error.name, code: error.code, operator: error.operator ?? null, message: error.message }, expectedReason: reason.source, reasonMatched: true });
    }
    const initial = await call(); assert.deepEqual(initial.predecessorRetainedSources, f.beforeRows);
    const receiptFile = path.join(f.options.outputRoot, 'receipt.json'), originalReceipt = await readFile(receiptFile);
    async function receiptMutation(name, edit, reason) {
        const receipt = JSON.parse(originalReceipt); edit(receipt); const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n'); await writeFile(receiptFile, bytes);
        try { await rejects(name, () => call({ expectedReceiptSha256: sha256(bytes) }), reason); } finally { await writeFile(receiptFile, originalReceipt); }
    }
    await rejects('external receipt digest', () => call({ expectedReceiptSha256: '0'.repeat(64) }), /Semantic checker preparation receipt digest changed/);
    await receiptMutation('honest-digest malformed schema', r => { r.schemaVersion = 2; }, /Semantic checker preparation schema changed/);
    await receiptMutation('honest-digest extra preparation field', r => { r.injected = true; }, /Semantic checker canonical preparation receipt changed/);
    await receiptMutation('honest-digest false inspected byte total', r => { r.selection.inspectedBytes++; }, /Semantic checker canonical preparation receipt changed/);
    await rejects('inactive row', () => call({ retainedSources: rows.map((r, n) => n === 0 ? { ...r, compile: false } : r) }), /Semantic checker selection requires active compiler inputs/);
    await rejects('missing sealed host', () => call({ retainedSources: rows.filter(r => r.path !== HOST) }), /Missing complete semantic checker or required boundary/);
    const target = rows.find(r => r.path === TARGETS[0]), originalTarget = await readFile(target.filename), privateRoot = path.dirname(process.env.FIR_SEMANTIC_FIXTURE);
    const copied = path.join(privateRoot, 'copied-owner.kt'); await writeFile(copied, originalTarget);
    await rejects('identical complete source under copied owner', () => call({ retainedSources: rows.map(r => r.path === target.path ? { ...r, filename: copied } : r) }), /Final semantic checker source owner\/metadata changed/);
    await rejects('target opaque metadata changed', () => call({ retainedSources: rows.map(r => r.path === target.path ? { ...r, opaque: { changed: true } } : r) }), /Final semantic checker source owner\/metadata changed/);
    async function sourceMutation(name, body, reason) {
        const bytes = Buffer.from(body); await writeFile(target.filename, bytes); const honest = { ...target, bytes: bytes.length, sha256: sha256(bytes) };
        try { await rejects(name, () => call({ retainedSources: rows.map(r => r.path === target.path ? honest : r) }), reason); } finally { await writeFile(target.filename, originalTarget); }
    }
    await sourceMutation('honest-digest reachable traversal depth mutation', originalTarget.toString().replace('depth = 1', 'depth = 2'), /Selected complete semantic checker algorithm\/import changed: .*FirContextualFunctionTypeChecker.kt/);
    await sourceMutation('honest-digest unknown import', originalTarget.toString().replace(/^package[^\n]+/m, '$&\nimport injected.Unknown'), /Selected complete semantic checker algorithm\/import changed/);
    const registry = rows.find(r => r.path === REGISTRIES[1]), registryBytes = Buffer.from((await readFile(registry.filename, 'utf8')).replace('        FirParenthesizedPackageQualifierChecker,', '        // removed genuine checker registration'));
    const registryFile = path.join(privateRoot, 'changed-registry.kt'); await writeFile(registryFile, registryBytes);
    await rejects('honest-digest live registration removed', () => call({ retainedSources: rows.map(r => r.path === registry.path ? { ...r, filename: registryFile, bytes: registryBytes.length, sha256: sha256(registryBytes) } : r) }), /Semantic checker required boundary changed: .*CommonExpressionCheckers.kt/);
    for (const [label, body, reason] of [
        ['alias consumer', 'package injected\nimport p.' + SYMBOLS[0] + ' as Alias\n', /New semantic checker declaration consumer or shadow: injected\/Incoming.kt/],
        ['new source subtype', 'package injected\nclass Added : KtSourceElement()\n', /New selected sealed source-family constructor/],
    ]) {
        const filename = path.join(privateRoot, label.replaceAll(' ', '-') + '.kt'), bytes = Buffer.from(body); await writeFile(filename, bytes);
        await rejects('actual ' + label, () => call({ retainedSources: [...rows, { path: 'injected/Incoming.kt', filename, bytes: bytes.length, sha256: sha256(bytes) }] }), reason);
    }
    const restored = await call(); assert.deepEqual(restored.predecessorRetainedSources, f.beforeRows);
    await writeJson(path.join(privateRoot, 'guards.json'), { schemaVersion: 1, kind: 'fir-semantic-reason-matched-public-guards', result: 'pass', records, guards: records.length, skipped: 0,
        initialPositivePassed: true, restoredPositivePassed: true, exactTwoRowReverseVerified: true, fullCompilerBuilt: false });
});
