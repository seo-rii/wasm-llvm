import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sha256 } from '../../scripts/source.mjs';
import { prepareHostSources } from '../host/prepare.mjs';
import { preparePositioningSources } from '../positioning/prepare.mjs';
import { guardNavigationCallers, prepareFirNavigationSources, verifyFirNavigation, verifyFirNavigationFinalSources } from './prepare.mjs';
import { NAVIGATION_PATHS, TOKEN_SET_PATH, transformNavigation } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources'), lock = JSON.parse(await readFile(path.join(here, 'sources.lock.json')));
const originals = new Map(); for (const pin of lock.sources) originals.set(pin.path, await readFile(path.join(sourceRoot, pin.path)));
const snapshot = [...originals].map(([relative, bytes]) => ({ path: relative, bytes: bytes.length, sha256: sha256(bytes), source: bytes.toString('base64') }));
const withText = (item, text) => ({ ...item, bytes: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)), source: Buffer.from(text).toString('base64') });

test('complete original bodies become exactly five pinned outputs with unchanged genuine LightTree checker', async () => {
    const tokenSet = await readFile(path.join(here, '../positioning/TokenSet.kt'));
    const generated = transformNavigation(originals, tokenSet);
    assert.deepEqual(generated.outputs.map(({ path, bytes }) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })), lock.outputs);
    assert.deepEqual(generated.changes, lock.changes);
    const checker = generated.outputs[3].bytes.toString();
    for (const method of ['checkModifiers(source)', 'checkAnnotations(source)', 'checkValOrVarKeyword(source)', 'for (modifier in modifiersList.modifiers)', 'for (ann in annotationsSource)']) assert(checker.includes(method));
    assert.equal(guardNavigationCallers(snapshot, lock, originals).retained.length, 7);
});

test('same-count selected navigation body mutation cannot be silently reverted', () => {
    const items = snapshot.map(item => item.path === NAVIGATION_PATHS[1] ? withText(item, Buffer.from(item.source, 'base64').toString().replace('if (idx-- == 0)', 'if (idx-- == 1)')) : item);
    assert.throws(() => guardNavigationCallers(items, lock, originals), /algorithm changed/);
});

test('removed private PSI helper and additional traversal consumers fail closed', () => {
    for (const text of ['fun x() = FirModifierList.FirPsiModifierList', 'fun x() = source.forEachChildOfType(types, 1) {}']) {
        const extra = withText({ path: 'selected/Unexpected.kt' }, 'package selected\n' + text);
        assert.throws(() => guardNavigationCallers([...snapshot, extra], lock, originals), /Unclosed|Unexpected traversal/);
    }
});

test('general TokenSet cached array getters and aliases are outside selected membership scope', () => {
    for (const text of ['import org.jetbrains.kotlin.portable.source.TokenSet\nfun x(t: TokenSet) = t.types',
        'import org.jetbrains.kotlin.portable.source.TokenSet as T\nfun x(t: T) = t.getTypes()']) {
        assert.throws(() => guardNavigationCallers([...snapshot, withText({ path: 'selected/Unexpected.kt' }, 'package selected\n' + text)], lock, originals), /cached\/ordered|alias/);
    }
});

test('missing actual traversal caller or changed caller receiver is rejected', () => {
    assert.throws(() => guardNavigationCallers(snapshot.filter(item => item.path !== lock.traversalConsumers[0]), lock, originals), /Missing retained/);
    const changed = snapshot.map(item => item.path === lock.traversalConsumers[0] ? withText(item, Buffer.from(item.source, 'base64').toString().replace('forEachChildOfType(', 'forEachChildOfTypeChanged(')) : item);
    assert.throws(() => guardNavigationCallers(changed, lock, originals), /algorithm changed/);
});

test('prepared predecessor/output and independent filename provenance are verified', async () => {
    const root = await mkdtemp(path.join(repository, 'out/kotlin-fir-navigation-guard-'));
    try {
        const preparedHost = await prepareHostSources({ sourceRoot, outputRoot: path.join(root, 'host') });
        const preparedPositioning = await preparePositioningSources({ sourceRoot, outputRoot: path.join(root, 'positioning') });
        const retainedSources = snapshot.map(item => ({ ...item, filename: path.join(sourceRoot, item.path) }));
        const prepared = await prepareFirNavigationSources({ sourceRoot, outputRoot: path.join(root, 'prepared'), retainedSources, preparedHost, preparedPositioning });
        await verifyFirNavigation(prepared.outputRoot);
        const filename = prepared.commonSources.find(file => file.endsWith('/' + TOKEN_SET_PATH));
        const original = await readFile(filename); await writeFile(filename, Buffer.concat([original, Buffer.from('// mutation\n')]));
        await assert.rejects(verifyFirNavigation(prepared.outputRoot)); await writeFile(filename, original);
        const receipt = JSON.parse(await readFile(prepared.receiptPath)); receipt.predecessorBindings[0].filename = path.join(repository, 'out/unverified/compiler-port-positioning/TokenSet.kt');
        await writeFile(prepared.receiptPath, JSON.stringify(receipt)); await assert.rejects(verifyFirNavigation(prepared.outputRoot));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('final assembly observes late callers and verifies only five exact replacements and known added imports', async () => {
    const root = await mkdtemp(path.join(repository, 'out/kotlin-fir-navigation-final-guard-'));
    try {
        const preparedHost = await prepareHostSources({ sourceRoot, outputRoot: path.join(root, 'host') });
        const preparedPositioning = await preparePositioningSources({ sourceRoot, outputRoot: path.join(root, 'positioning') });
        const initial = snapshot.map(item => ({ ...item, filename: path.join(sourceRoot, item.path) }));
        const prepared = await prepareFirNavigationSources({ sourceRoot, outputRoot: path.join(root, 'prepared'), retainedSources: initial, preparedHost, preparedPositioning });
        const selected = new Map(initial.map(item => [item.path, item]));
        for (const entry of lock.outputs) selected.set(entry.path, { ...entry, filename: path.join(prepared.outputRoot, entry.path) });
        const params = { profileRoot: prepared.outputRoot, retainedSources: [...selected.values()], allowedAddedImports: ['kotlin.jvm.*'] };
        const lateFile = path.join(root, 'LateConsumer.kt');
        for (const text of ['package late\nfun use() = FirModifierList.FirPsiModifierList\n',
            'package late\nimport org.jetbrains.kotlin.portable.source.TokenSet\nfun use(t: TokenSet) = t.types\n']) {
            const bytes = Buffer.from(text); await writeFile(lateFile, bytes);
            await assert.rejects(verifyFirNavigationFinalSources({ ...params, retainedSources: [...params.retainedSources,
                { path: 'late/LateConsumer.kt', filename: lateFile, bytes: bytes.length, sha256: sha256(bytes) }] }), /Unclosed|cached\/ordered/);
        }
        const changedFile = selected.get(NAVIGATION_PATHS[1]).filename, original = await readFile(changedFile);
        const replacement = bytes => params.retainedSources.map(item => item.path === NAVIGATION_PATHS[1] ? { ...item, bytes: bytes.length, sha256: sha256(bytes) } : item);
        const bodyChange = Buffer.from(original.toString().replace('if (idx-- == 0)', 'if (idx-- == 1)')); await writeFile(changedFile, bodyChange);
        await assert.rejects(verifyFirNavigationFinalSources({ ...params, retainedSources: replacement(bodyChange) }), /body changed/);
        const importChange = Buffer.from(original.toString().replace('import org.jetbrains.kotlin.portable.source.IElementType', 'import unknown.host.IElementType')); await writeFile(changedFile, importChange);
        await assert.rejects(verifyFirNavigationFinalSources({ ...params, retainedSources: replacement(importChange) }), /Canonical host import/);
        const unknown = Buffer.from(original.toString().replace(/^package[^\n]+/m, '$&\nimport unknown.host.Alias')); await writeFile(changedFile, unknown);
        await assert.rejects(verifyFirNavigationFinalSources({ ...params, retainedSources: replacement(unknown) }), /Unverified host import/);
        const added = Buffer.from(original.toString().replace(/^package[^\n]+/m, '$&\nimport kotlin.jvm.*')); await writeFile(changedFile, added);
        // Root assembly mutates these canonical output files in place. The
        // strict pre-assembly verifier must reject them, while the final guard
        // replays immutable originals and permits only the bound import.
        await assert.rejects(verifyFirNavigation(prepared.outputRoot));
        const copy = path.join(root, 'CopiedSourceUtils.kt'); await writeFile(copy, added);
        await assert.rejects(verifyFirNavigationFinalSources({ ...params, retainedSources: replacement(added).map(item => item.path === NAVIGATION_PATHS[1] ? { ...item, filename: copy } : item) }), /filename changed/);
        const final = await verifyFirNavigationFinalSources({ ...params, retainedSources: replacement(added) });
        assert.equal(final.receipt.bindings.length, 5); assert.equal(final.receipt.inspectedKotlinFiles, 9);
        assert.deepEqual(final.receipt.shadowedPaths, [...NAVIGATION_PATHS, TOKEN_SET_PATH]);
        assert.deepEqual(final.receipt.bindings.find(item => item.path === NAVIGATION_PATHS[1]).addedImports, ['kotlin.jvm.*']);
    } finally { await rm(root, { recursive: true, force: true }); }
});
